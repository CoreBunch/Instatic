import { describe, test, expect } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'

describe('SQLite adapter smoke test', () => {
  test('site → data_row draft round-trip with JSON columns', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // ── 1. Insert the singleton site row ────────────────────────────────────
      // The schema enforces id = 'default' via a CHECK constraint; no other id
      // is permitted.
      await db`
        insert into site (id, name, settings_json)
        values ('default', ${'Test Site'}, ${{}})`

      // ── 2. Insert a data_row with a JSON column, capture id via RETURNING ───
      // The migrations seed 'pages' as a system table; we can insert a row
      // into it to exercise the cells_json round-trip.
      const rowId = crypto.randomUUID()
      const cells = { title: 'Test Page', slug: 'test-page', body: { nodes: {}, rootNodeId: 'root' } }

      const { rows: insertedRows } = await db<{ id: string }>`
        insert into data_rows (id, table_id, slug, status, cells_json)
        values (${rowId}, ${'pages'}, ${'test-page'}, ${'draft'}, ${cells})
        returning id`

      // RETURNING must give back the row we just inserted
      expect(insertedRows).toHaveLength(1)
      expect(insertedRows[0]!.id).toBe(rowId)

      // ── 3. Read the JSON column back — adapter must parse TEXT → object ─────
      const { rows } = await db<{ cells_json: unknown }>`
        select cells_json from data_rows where id = ${rowId}`

      expect(rows).toHaveLength(1)

      // Critical assertion: _json columns must be deserialized to objects, not
      // returned as raw SQLite TEXT strings. This validates the normalizeSqliteRow
      // logic in the SQLite adapter.
      expect(typeof rows[0]!.cells_json).toBe('object')
      expect(rows[0]!.cells_json).toEqual(cells)

      // ── 4. ON CONFLICT DO UPDATE + current_timestamp ─────────────────────────
      await db`
        insert into site (id, name, settings_json)
        values ('default', ${'Updated Site'}, ${{}}  )
        on conflict (id) do update set
          name       = excluded.name,
          updated_at = current_timestamp`

      const { rows: siteRows } = await db<{ name: string; updated_at: string }>`
        select name, updated_at from site where id = 'default'`

      expect(siteRows).toHaveLength(1)
      expect(siteRows[0]!.name).toBe('Updated Site')

      // current_timestamp must have produced a non-empty timestamp string
      expect(typeof siteRows[0]!.updated_at).toBe('string')
      expect(siteRows[0]!.updated_at.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  test('transaction() commits on success', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await db.transaction(async (tx) => {
        await tx`insert into users (id, email, email_normalized, display_name, password_hash, role_id) values (${'a1'}, ${'a@example.com'}, ${'a@example.com'}, ${'A'}, ${'hash1'}, ${'member'})`
        await tx`insert into users (id, email, email_normalized, display_name, password_hash, role_id) values (${'a2'}, ${'b@example.com'}, ${'b@example.com'}, ${'B'}, ${'hash2'}, ${'member'})`
      })

      const { rows } = await db<{ count: number }>`select count(*) as count from users`
      expect(rows[0]!.count).toBe(2)
    } finally {
      await cleanup()
    }
  })

  test('transaction() rolls back on error and leaves DB untouched', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // Pre-existing row outside the tx so we can prove only the tx writes were rolled back.
      await db`insert into users (id, email, email_normalized, display_name, password_hash, role_id) values (${'pre'}, ${'pre@example.com'}, ${'pre@example.com'}, ${'Pre'}, ${'hashp'}, ${'member'})`

      const sentinel = new Error('rollback this tx')
      let caught: unknown = null
      try {
        await db.transaction(async (tx) => {
          await tx`insert into users (id, email, email_normalized, display_name, password_hash, role_id) values (${'tx1'}, ${'tx1@example.com'}, ${'tx1@example.com'}, ${'Tx1'}, ${'hash1'}, ${'member'})`
          await tx`insert into users (id, email, email_normalized, display_name, password_hash, role_id) values (${'tx2'}, ${'tx2@example.com'}, ${'tx2@example.com'}, ${'Tx2'}, ${'hash2'}, ${'member'})`
          throw sentinel
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBe(sentinel)

      // The pre-existing row survives; the two tx inserts were rolled back.
      const { rows } = await db<{ id: string }>`select id from users order by id`
      expect(rows.map((r) => r.id)).toEqual(['pre'])
    } finally {
      await cleanup()
    }
  })

  test('foreign keys are enforced (PRAGMA foreign_keys = ON)', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // sessions.user_id has an FK to users(id). Inserting a session for a
      // non-existent user must fail when foreign_keys is on.
      let caught: unknown = null
      try {
        await db`
          insert into sessions (id_hash, user_id, expires_at)
          values (${'sess1'}, ${'nonexistent-user'}, ${new Date(Date.now() + 60_000)})`
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect(String(caught)).toMatch(/foreign key/i)

      // And the row must NOT exist.
      const { rows } = await db<{ id_hash: string }>`select id_hash from sessions`
      expect(rows).toHaveLength(0)
    } finally {
      await cleanup()
    }
  })

  test('BLOB round-trip for published_runtime_assets.content_bytes', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // Set up the FK chain: user → data_row → data_row_version → asset.
      // The migrations seed 'pages' as a system table, so we can insert rows
      // there without creating a data_table first.
      await db`insert into users (id, email, email_normalized, display_name, password_hash, role_id) values (${'user1'}, ${'a@example.com'}, ${'a@example.com'}, ${'A'}, ${'hash'}, ${'member'})`
      await db`
        insert into data_rows (id, table_id, slug, status, cells_json)
        values (${'row1'}, ${'pages'}, ${'page'}, ${'published'}, ${{ title: 'Page', slug: 'page' }})`
      await db`
        insert into data_row_versions (id, row_id, version_number, cells_json, slug, published_by_user_id)
        values (${'drv1'}, ${'row1'}, ${1}, ${{ title: 'Page', slug: 'page' }}, ${'page'}, ${'user1'})`

      const payload = new Uint8Array([0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0xfe, 0xed])
      await db`
        insert into published_runtime_assets
          (id, data_row_version_id, asset_path, public_path, content_type, content_bytes)
        values (${'a1'}, ${'drv1'}, ${'/main.js'}, ${'/_instatic/assets/drv1/main.js'}, ${'text/javascript'}, ${payload})`

      const { rows } = await db<{ content_bytes: Uint8Array }>`
        select content_bytes from published_runtime_assets where id = ${'a1'}`
      expect(rows).toHaveLength(1)

      const out = rows[0]!.content_bytes
      // bun:sqlite returns BLOBs as Uint8Array (or Buffer, which extends Uint8Array).
      expect(out).toBeInstanceOf(Uint8Array)
      expect(Array.from(out)).toEqual(Array.from(payload))
    } finally {
      await cleanup()
    }
  })

  test('boolean values bind as 0/1 and survive a round-trip', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const manifest = { id: 'p1', name: 'Test Plugin', version: '1.0.0' }
      await db`
        insert into installed_plugins (id, name, version, manifest_json, enabled)
        values (${'p1'}, ${'Test Plugin'}, ${'1.0.0'}, ${manifest}, ${false})`

      const { rows } = await db<{ enabled: number; manifest_json: unknown }>`
        select enabled, manifest_json from installed_plugins where id = ${'p1'}`
      expect(rows).toHaveLength(1)

      // SQLite stores booleans as 0/1; repos coerce with Boolean(row.enabled).
      expect(rows[0]!.enabled).toBe(0)
      expect(Boolean(rows[0]!.enabled)).toBe(false)
      // _json column was deserialised back into an object.
      expect(rows[0]!.manifest_json).toEqual(manifest)
    } finally {
      await cleanup()
    }
  })
})
