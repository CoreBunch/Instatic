/**
 * Integration tests for the visitor profile-field repository layer.
 *
 * Pins the contract of `updateVisitorUserProfileFields` / `findVisitorUserById`
 * against a real migrated SQLite DB (`createTestDb()` applies migration `025`,
 * which adds `visitor_users.profile_fields_json`). The load-bearing contract
 * documented in the repository:
 *
 *   > Update a visitor's custom profile field VALUES. **Stores the whole map**
 *   > — callers should merge against the current values first. Empty object
 *   > is valid (clears all profile fields).
 *
 * This test pins that LAYERING: the repository writes the WHOLE map (no
 * merge), so the merge — when it is wanted — is the handler's job, not the
 * repo's. Asserting that a second write with a disjoint key REPLACES (not
 * merges) keeps the layering honest and prevents the repo from silently
 * growing merge logic that would duplicate the handler's responsibility.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import {
  updateVisitorUserProfileFields,
  findVisitorUserById,
} from '../../../server/visitor-auth/repositories'

type Db = TestDb['db']

let testDb: TestDb
let db: Db

/**
 * Insert a fresh visitor user for a test. Mirrors the migration `021`
 * `visitor_users` columns (`id, email, email_normalized, password_hash,
 * display_name, role_id, status`) — the system `member` role is seeded by
 * migration `021`, so it is reused as the role_id.
 */
async function seedVisitor(db: Db, id: string): Promise<void> {
  await db`
    insert into visitor_users (id, email, email_normalized, password_hash, display_name, role_id, status)
    values (${id}, ${id + '@example.com'}, ${id + '@example.com'}, 'h', ${id}, 'member', 'active')
  `
}

beforeAll(async () => {
  testDb = await createTestDb()
  db = testDb.db
})

afterAll(async () => {
  await testDb.cleanup()
})

describe('updateVisitorUserProfileFields / findVisitorUserById', () => {
  it('writes the profile-field JSON and reads it back via findVisitorUserById', async () => {
    await seedVisitor(db, 'v-profile')

    const updated = await updateVisitorUserProfileFields(db, 'v-profile', { schoolName: 'Oasis' })
    expect(updated).not.toBeNull()
    expect(updated!.profileFields.schoolName).toBe('Oasis')

    // A fresh read round-trips through the column adapter / normaliser.
    const reread = await findVisitorUserById(db, 'v-profile')
    expect(reread).not.toBeNull()
    expect(reread!.profileFields.schoolName).toBe('Oasis')
  })

  it('clears all profile fields when given an empty object', async () => {
    await seedVisitor(db, 'v-clear')
    // Seed a value first, then clear it.
    await updateVisitorUserProfileFields(db, 'v-clear', { schoolName: 'Oasis', grade: 'Y2' })

    const cleared = await updateVisitorUserProfileFields(db, 'v-clear', {})
    expect(cleared).not.toBeNull()
    expect(cleared!.profileFields).toEqual({})

    const reread = await findVisitorUserById(db, 'v-clear')
    expect(reread!.profileFields).toEqual({})
  })

  it('stores the WHOLE map (no merge) — pinning the documented layering', async () => {
    await seedVisitor(db, 'v-merge')

    // First write carries key `a`.
    await updateVisitorUserProfileFields(db, 'v-merge', { a: '1' })

    // Second write carries a DISJOINT key `b`. Per the documented contract,
    // the repository writes the whole map — it does NOT merge against the
    // existing `a`. So `a` is gone and only `b` remains.
    const result = await updateVisitorUserProfileFields(db, 'v-merge', { b: '2' })
    expect(result).not.toBeNull()

    // Result is { b: '2' }, NOT { a: '1', b: '2' } — the merge (when wanted)
    // is the handler's responsibility, never the repo's.
    expect(result!.profileFields).toEqual({ b: '2' })
    expect(result!.profileFields).not.toHaveProperty('a')

    const reread = await findVisitorUserById(db, 'v-merge')
    expect(reread!.profileFields).toEqual({ b: '2' })
  })
})
