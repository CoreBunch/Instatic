/**
 * Email addresses are validated at every account boundary with ONE shared
 * check (`@core/utils/email`): the setup endpoint and the users repository
 * (which backs the users admin API). `includes('@')` used to be the whole
 * server-side rule, so `owner@localhost`-style junk created real accounts.
 * Patches that do not touch the email must still work on a user whose
 * stored address predates the check.
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { hashPassword } from '../../../server/auth/tokens'
import {
  UserMutationError,
  createUser,
  updateUser,
} from '../../../server/repositories/users'
import { isValidEmail } from '@core/utils/email'
import { createTestDb } from '../helpers/createTestDb'

const PASSWORD = 'long-enough-password'

async function runSetup(db: DbClient, email: string): Promise<Response> {
  return await handleCmsRequest(
    new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'Test', email, password: PASSWORD }),
    }),
    db,
  )
}

async function createAdmin(db: DbClient, email: string) {
  return await createUser(db, {
    email,
    displayName: 'Someone',
    passwordHash: await hashPassword(PASSWORD),
    roleId: 'admin',
  })
}

describe('isValidEmail', () => {
  it('accepts ordinary addresses and rejects non-emails', () => {
    expect(isValidEmail('owner@example.com')).toBe(true)
    expect(isValidEmail('first.last+tag@sub.example.co')).toBe(true)

    expect(isValidEmail('not-an-email')).toBe(false)
    expect(isValidEmail('owner@localhost')).toBe(false) // no dot in the domain
    expect(isValidEmail('owner@')).toBe(false)
    expect(isValidEmail('@example.com')).toBe(false)
    expect(isValidEmail('owner@exam ple.com')).toBe(false)
    expect(isValidEmail('owner@example.')).toBe(false)
    expect(isValidEmail('')).toBe(false)
  })
})

describe('setup email validation', () => {
  it('rejects a non-email with a 400 and creates nothing', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      for (const junk of ['not-an-email', 'owner@localhost', 'owner@']) {
        const res = await runSetup(db, junk)
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'Invalid email address' })
      }
      // The site was never created, so setup still runs with a real address.
      expect((await runSetup(db, 'owner@example.com')).status).toBe(201)
    } finally {
      await cleanup()
    }
  })
})

describe('users repository email validation', () => {
  it('createUser rejects an invalid email', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      await expect(createAdmin(db, 'someone@nowhere')).rejects.toThrow(
        new UserMutationError('Invalid email address'),
      )
    } finally {
      await cleanup()
    }
  })

  it('updateUser rejects changing the email to an invalid one', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const user = await createAdmin(db, 'someone@example.com')
      await expect(updateUser(db, user.id, { email: 'broken@' })).rejects.toThrow(
        new UserMutationError('Invalid email address'),
      )
    } finally {
      await cleanup()
    }
  })

  it('updateUser still patches a user whose STORED email predates the check', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const user = await createAdmin(db, 'someone@example.com')
      // Simulate a pre-validation record written when includes('@') was the rule.
      await db`
        update users
        set email = ${'legacy@intranet'}, email_normalized = ${'legacy@intranet'}
        where id = ${user.id}
      `
      const patched = await updateUser(db, user.id, { status: 'suspended' })
      expect(patched?.status).toBe('suspended')
      expect(patched?.email).toBe('legacy@intranet')
    } finally {
      await cleanup()
    }
  })
})
