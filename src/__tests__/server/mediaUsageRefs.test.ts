/**
 * Knowing that something still depends on a media asset.
 *
 * `media_usage_refs` shipped with the media schema and nothing ever wrote to
 * it, so the library could not tell a decorative upload from an asset the
 * product depends on. A profile picture is stored as an ordinary library row
 * with no marker of any kind — so tidying up the library swept one into the
 * trash, purging it hard-deleted the row, and `users.avatar_media_id` went
 * quietly to NULL through its `on delete set null` foreign key. The profile
 * fell back to a Gravatar identicon with nothing to explain why.
 *
 * These cover the two behaviours the warning depends on: a reference MOVES
 * rather than accumulating, and a cleared one stops reporting.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import {
  listMediaUsageRefs,
  setMediaUsageRef,
} from '../../../server/repositories/media'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function freshDb() {
  const { db, cleanup } = await createTestDb()
  cleanups.push(cleanup)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, status, role_id)
    values ('u1', 'ada@example.com', 'ada@example.com', 'Ada Lovelace', 'hash', 'active', 'owner')
  `
  return db
}

async function insertAsset(db: Awaited<ReturnType<typeof freshDb>>, id: string) {
  await db`
    insert into media_assets (id, filename, mime_type, size_bytes, storage_path, public_path)
    values (${id}, ${`${id}.png`}, 'image/png', 10, ${`/s/${id}`}, ${`/uploads/${id}.png`})
  `
}

describe('media usage references', () => {
  it('reports nothing for an asset nobody depends on', async () => {
    const db = await freshDb()
    await insertAsset(db, 'a1')
    expect(await listMediaUsageRefs(db, ['a1'])).toEqual([])
  })

  it('names the person whose avatar it is, not the raw id', async () => {
    // The whole point is a confirmation an operator can act on. "u1" tells
    // them nothing; "Ada Lovelace" tells them what breaks.
    const db = await freshDb()
    await insertAsset(db, 'a1')
    await setMediaUsageRef(db, { assetId: 'a1', refKind: 'user.avatar', refId: 'u1' })

    const refs = await listMediaUsageRefs(db, ['a1'])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.label).toBe('Ada Lovelace')
    expect(refs[0]!.refKind).toBe('user.avatar')
  })

  it('falls back to the email when there is no display name', async () => {
    const db = await freshDb()
    await db`update users set display_name = '' where id = 'u1'`
    await insertAsset(db, 'a1')
    await setMediaUsageRef(db, { assetId: 'a1', refKind: 'user.avatar', refId: 'u1' })
    expect((await listMediaUsageRefs(db, ['a1']))[0]!.label).toBe('ada@example.com')
  })

  it('MOVES the reference when the avatar is replaced', async () => {
    // Four avatar changes must leave one row, not four — otherwise deleting
    // the fifth picture would warn about ones replaced months ago, and the
    // warning becomes noise the operator learns to click past.
    const db = await freshDb()
    await insertAsset(db, 'old')
    await insertAsset(db, 'new')
    await setMediaUsageRef(db, { assetId: 'old', refKind: 'user.avatar', refId: 'u1' })
    await setMediaUsageRef(db, { assetId: 'new', refKind: 'user.avatar', refId: 'u1' })

    expect(await listMediaUsageRefs(db, ['old'])).toEqual([])
    expect((await listMediaUsageRefs(db, ['new']))[0]!.label).toBe('Ada Lovelace')
  })

  it('stops reporting once the avatar is cleared', async () => {
    // The asset deliberately stays in the library, but nothing depends on it
    // any more — so deleting it should no longer warn.
    const db = await freshDb()
    await insertAsset(db, 'a1')
    await setMediaUsageRef(db, { assetId: 'a1', refKind: 'user.avatar', refId: 'u1' })
    await setMediaUsageRef(db, { assetId: null, refKind: 'user.avatar', refId: 'u1' })
    expect(await listMediaUsageRefs(db, ['a1'])).toEqual([])
  })

  it('answers for a whole selection in one call', async () => {
    // The deletion path asks about every selected file at once; asking per
    // file would mean one round trip per row of a bulk delete.
    const db = await freshDb()
    for (const id of ['a1', 'a2', 'a3']) await insertAsset(db, id)
    await setMediaUsageRef(db, { assetId: 'a2', refKind: 'user.avatar', refId: 'u1' })

    const refs = await listMediaUsageRefs(db, ['a1', 'a2', 'a3'])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.assetId).toBe('a2')
  })

  it('returns nothing for an empty selection without touching the database', async () => {
    const db = await freshDb()
    expect(await listMediaUsageRefs(db, [])).toEqual([])
  })
})

/**
 * Run one shipped migration's own SQL, by id.
 *
 * `createTestDb` has already applied every migration before the test writes a
 * row, so the backfill ran against an empty `users` table and the tracker now
 * says it is done. Replaying its SQL directly is what actually exercises it —
 * and running it twice is the only honest test of the `not exists` guard.
 */
async function replayMigration(db: Awaited<ReturnType<typeof freshDb>>, id: string) {
  const list = db.dialect === 'postgres' ? pgMigrations : sqliteMigrations
  const migration = list.find((m) => m.id === id)
  if (!migration) throw new Error(`No migration ${id} — was it renamed?`)
  await db.unsafe(migration.sql)
}

const BACKFILL = '028_backfill_avatar_usage_refs'

describe('the avatar backfill', () => {
  it('protects an avatar that was set before anything recorded usage', async () => {
    // Every install that already has an avatar is in exactly this state.
    // Without the backfill, the first build that warns before a delete would
    // still say nothing about the picture already set — the one case the
    // whole feature exists for.
    const db = await freshDb()
    await insertAsset(db, 'a1')
    await db`update users set avatar_media_id = 'a1' where id = 'u1'`

    await replayMigration(db, BACKFILL)

    const refs = await listMediaUsageRefs(db, ['a1'])
    expect(refs).toHaveLength(1)
    expect(refs[0]!.refKind).toBe('user.avatar')
    expect(refs[0]!.label).toBe('Ada Lovelace')
  })

  it('adds nothing on top of a reference that is already there', async () => {
    const db = await freshDb()
    await insertAsset(db, 'a1')
    await db`update users set avatar_media_id = 'a1' where id = 'u1'`
    await setMediaUsageRef(db, { assetId: 'a1', refKind: 'user.avatar', refId: 'u1' })

    await replayMigration(db, BACKFILL)
    await replayMigration(db, BACKFILL)

    expect(await listMediaUsageRefs(db, ['a1'])).toHaveLength(1)
  })

  it('leaves a user with no avatar alone', async () => {
    const db = await freshDb()
    await insertAsset(db, 'a1')
    await replayMigration(db, BACKFILL)
    expect(await listMediaUsageRefs(db, ['a1'])).toEqual([])
  })

  it('writes the row a later avatar change will MOVE, not a second one', async () => {
    // The backfilled row has to be indistinguishable from one the app wrote,
    // or changing the avatar afterwards would leave the old picture warning
    // forever. `setMediaUsageRef` deletes on (ref_kind, ref_id, ref_path) —
    // so the backfill must write the same key.
    const db = await freshDb()
    await insertAsset(db, 'old')
    await insertAsset(db, 'new')
    await db`update users set avatar_media_id = 'old' where id = 'u1'`
    await replayMigration(db, BACKFILL)

    await setMediaUsageRef(db, { assetId: 'new', refKind: 'user.avatar', refId: 'u1' })

    expect(await listMediaUsageRefs(db, ['old'])).toEqual([])
    expect(await listMediaUsageRefs(db, ['new'])).toHaveLength(1)
  })
})
