import { describe, expect, it } from 'bun:test'
import { createTestDb } from '../helpers/createTestDb'
import {
  createSite,
  getSetupStatus,
  getSetupStatusCached,
  resetSetupStatusCacheForTests,
} from '../../../server/repositories/setup'
import { createUser, findUserByEmail } from '../../../server/repositories/users'
import { createCustomRole, listRoles } from '../../../server/repositories/roles'
import { createSession, findUserBySessionHash, revokeSessionByHash } from '../../../server/auth/sessions'
import { hashPassword } from '../../../server/auth/tokens'

describe('CMS repositories', () => {
  it('reports setup incomplete until site and active owner exist', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      expect(await getSetupStatus(db)).toMatchObject({
        hasSite: false,
        hasAdmin: false,
        hasOwner: false,
        needsSetup: true,
      })

      await createSite(db, 'Example Site', {})
      await createUser(db, {
        id: 'owner_1',
        email: 'Owner@Example.com',
        displayName: 'Owner',
        passwordHash: await hashPassword('long-enough-password'),
        roleId: 'owner',
        allowOwnerRole: true,
      })

      expect(await getSetupStatus(db)).toMatchObject({
        hasSite: true,
        hasAdmin: true,
        hasOwner: true,
        needsSetup: false,
      })
    } finally {
      await cleanup()
    }
  })

  it('getSetupStatusCached re-queries while pending, then memoizes the settled status', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      // Pending: every call queries live so an in-progress setup is observed.
      expect((await getSetupStatusCached(db)).needsSetup).toBe(true)
      await createSite(db, 'Example Site', {})
      expect((await getSetupStatusCached(db)).needsSetup).toBe(true) // owner still missing
      await createUser(db, {
        id: 'owner_1',
        email: 'owner@example.com',
        displayName: 'Owner',
        passwordHash: await hashPassword('long-enough-password'),
        roleId: 'owner',
        allowOwnerRole: true,
      })
      expect((await getSetupStatusCached(db)).needsSetup).toBe(false)

      // Settled: the memo answers without touching the DB. Prove it by
      // removing the owner out-of-band — the app itself never allows this,
      // which is exactly why the memo is sound.
      await db`delete from users`
      expect((await getSetupStatusCached(db)).needsSetup).toBe(false)
      expect((await getSetupStatus(db)).needsSetup).toBe(true) // live variant sees raw truth

      // The test-only reset drops the memo and querying resumes.
      resetSetupStatusCacheForTests()
      expect((await getSetupStatusCached(db)).needsSetup).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('getSetupStatusCached keys its memo per DbClient — fresh databases stay isolated', async () => {
    const settled = await createTestDb()
    const fresh = await createTestDb()
    try {
      await createSite(settled.db, 'Example Site', {})
      await createUser(settled.db, {
        id: 'owner_1',
        email: 'owner@example.com',
        displayName: 'Owner',
        passwordHash: await hashPassword('long-enough-password'),
        roleId: 'owner',
        allowOwnerRole: true,
      })
      expect((await getSetupStatusCached(settled.db)).needsSetup).toBe(false)

      // A different client must not inherit the settled memo.
      expect((await getSetupStatusCached(fresh.db)).needsSetup).toBe(true)
    } finally {
      await settled.cleanup()
      await fresh.cleanup()
    }
  })

  it('creates and finds users by normalized email', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await createUser(db, {
        id: 'user_1',
        email: 'Owner@Example.com',
        displayName: 'Owner',
        passwordHash: 'hash',
        roleId: 'member',
      })

      expect(await findUserByEmail(db, 'owner@example.com')).toMatchObject({
        id: 'user_1',
        email: 'Owner@Example.com',
        role: { slug: 'member' },
      })
    } finally {
      await cleanup()
    }
  })

  it('lists built-in roles by rank before custom roles', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await createCustomRole(db, {
        name: 'Auditor',
        description: 'Reads audit activity.',
        capabilities: ['audit.read'],
      })

      expect((await listRoles(db)).map((role) => role.slug)).toEqual([
        'owner',
        'admin',
        'client',
        'member',
        'auditor',
      ])
    } finally {
      await cleanup()
    }
  })

  it('stores session token hashes and rejects revoked sessions', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await createUser(db, {
        id: 'user_1',
        email: 'owner@example.com',
        displayName: 'Owner',
        passwordHash: 'hash',
        roleId: 'member',
      })
      await createSession(db, {
        idHash: 'abc123',
        userId: 'user_1',
        expiresAt: new Date('2030-01-01'),
        ipAddress: '127.0.0.1',
        userAgent: 'test',
      })

      expect(await findUserBySessionHash(db, 'abc123')).toMatchObject({ id: 'user_1' })
      await revokeSessionByHash(db, 'abc123')
      expect(await findUserBySessionHash(db, 'abc123')).toBeNull()
    } finally {
      await cleanup()
    }
  })
})
