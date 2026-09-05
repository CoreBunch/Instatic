import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../../db/sqlite'
import { sqliteMigrations } from '../../../../db/migrations-sqlite'
import { runMigrations } from '../../../../db/runMigrations'
import type { DbClient } from '../../../../db/client'
import { softDeleteDataRow, upsertDataRowDraft } from '../mutations'
import { getDataRow } from '../read'
import { MAIN_SCOPE } from '../../../../branches/scope'

const USER_ID = 'user-author'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
    values (${USER_ID}, ${'author@example.com'}, ${'author@example.com'}, ${'Author Person'}, ${'x'}, ${'active'}, ${'owner'})
  `
  return db
}

async function seedRow(db: DbClient, id: string): Promise<void> {
  await db`
    insert into data_rows (id, table_id, cells_json, slug, status, author_user_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
    values (
      ${id}, ${'posts'}, ${{ title: id, slug: id }}, ${id}, ${'draft'},
      ${USER_ID}, ${USER_ID}, ${USER_ID},
      ${'2024-01-01T00:00:00.000Z'}, ${'2024-01-01T00:00:00.000Z'}
    )
  `
}

describe('softDeleteDataRow', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
    await seedRow(db, 'post-1')
  })

  it('returns the narrow deleted-row summary', async () => {
    const result = await softDeleteDataRow(db, MAIN_SCOPE, 'post-1', USER_ID)
    expect(result).not.toBeNull()
    if (!result) throw new Error('expected a summary')

    expect(result.id).toBe('post-1')
    expect(result.tableId).toBe('posts')
    expect(result.slug).toBe('post-1')
    expect(result.status).toBe('draft')
    expect(typeof result.deletedAt).toBe('string')

    // The summary shape exposes ONLY these keys — no user-ref fields.
    expect(Object.keys(result).sort()).toEqual(
      ['deletedAt', 'id', 'slug', 'status', 'tableId'],
    )

    // Compile-time guarantee: the result type does not carry hydrated user refs.
    // @ts-expect-error createdBy is not part of DeletedRowSummary
    void result.createdBy
    // @ts-expect-error author is not part of DeletedRowSummary
    void result.author
  })

  it('hides the row from the hydrated read afterwards', async () => {
    await softDeleteDataRow(db, MAIN_SCOPE, 'post-1', USER_ID)
    expect(await getDataRow(db, MAIN_SCOPE, 'post-1')).toBeNull()
  })

  it('returns null when the row is already gone', async () => {
    await softDeleteDataRow(db, MAIN_SCOPE, 'post-1', USER_ID)
    expect(await softDeleteDataRow(db, MAIN_SCOPE, 'post-1', USER_ID)).toBeNull()
    expect(await softDeleteDataRow(db, MAIN_SCOPE, 'missing', USER_ID)).toBeNull()
  })
})

describe('upsertDataRowDraft', () => {
  let db: DbClient
  beforeEach(async () => {
    db = await freshDb()
  })

  it('updates a live row in place', async () => {
    await seedRow(db, 'post-1')
    await upsertDataRowDraft(
      db,
     MAIN_SCOPE,
      { id: 'post-1', tableId: 'posts', cells: { title: 'Updated' }, slug: 'updated' },
      USER_ID,
    )
    const row = await getDataRow(db, MAIN_SCOPE, 'post-1')
    expect(row?.cells.title).toBe('Updated')
    expect(row?.slug).toBe('updated')
  })

  it('creates a fresh row when the id is unknown', async () => {
    await upsertDataRowDraft(
      db,
     MAIN_SCOPE,
      { id: 'post-new', tableId: 'posts', cells: { title: 'Fresh' }, slug: 'fresh' },
      USER_ID,
    )
    expect((await getDataRow(db, MAIN_SCOPE, 'post-new'))?.cells.title).toBe('Fresh')
  })

  it('RESURRECTS a soft-deleted row instead of hitting its primary key', async () => {
    // The undo-of-delete flow: a row the roster sweep soft-deleted, then a
    // peer restored. getDataRow filters soft-deleted rows, so a plain insert
    // would conflict on the still-present primary key forever.
    await seedRow(db, 'post-1')
    await softDeleteDataRow(db, MAIN_SCOPE, 'post-1', USER_ID)
    expect(await getDataRow(db, MAIN_SCOPE, 'post-1')).toBeNull() // soft-deleted, hidden

    await upsertDataRowDraft(
      db,
     MAIN_SCOPE,
      { id: 'post-1', tableId: 'posts', cells: { title: 'Revived' }, slug: 'revived' },
      USER_ID,
    )

    const revived = await getDataRow(db, MAIN_SCOPE, 'post-1')
    expect(revived).not.toBeNull()
    expect(revived?.cells.title).toBe('Revived')
    expect(revived?.deletedAt).toBeNull()
  })
})
