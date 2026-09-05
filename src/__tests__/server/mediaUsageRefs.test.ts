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
