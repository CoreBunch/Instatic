/**
 * A display name is never silently the account's email address.
 *
 * `display_name` is rendered on PUBLIC pages through author bindings, and both
 * setup and `createUser` used to default it to the email. So a fresh install
 * had the owner's address sitting in a publicly-bindable field before anyone
 * had written a line of content, and the only way to change it was the account
 * page after the fact.
 *
 * Setup now takes an optional `displayName`, and an unset name stays empty.
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { createUser, findUserByEmail } from '../../../server/repositories/users'
import { createTestDb } from '../helpers/createTestDb'

const EMAIL = 'owner@example.com'
const PASSWORD = 'long-enough-password'

async function runSetup(db: DbClient, body: Record<string, unknown>): Promise<Response> {
  return await handleCmsRequest(
    new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'Test', email: EMAIL, password: PASSWORD, ...body }),
    }),
    db,
  )
}

describe('setup display name', () => {
  it('leaves the display name empty when none is given', async () => {
    const { db } = await createTestDb()
    expect((await runSetup(db, {})).status).toBe(201)

    const owner = await findUserByEmail(db, EMAIL)
    expect(owner?.displayName).toBe('')
    expect(owner?.displayName).not.toContain('@')
  })

  it('stores the display name given at setup', async () => {
    const { db } = await createTestDb()
    expect((await runSetup(db, { displayName: 'Rosa Ferrandis' })).status).toBe(201)

    expect((await findUserByEmail(db, EMAIL))?.displayName).toBe('Rosa Ferrandis')
  })

  it('trims a whitespace-only display name to empty rather than the email', async () => {
    const { db } = await createTestDb()
    expect((await runSetup(db, { displayName: '   ' })).status).toBe(201)

    expect((await findUserByEmail(db, EMAIL))?.displayName).toBe('')
  })
})

describe('createUser display name', () => {
  it('does not fall back to the email address', async () => {
    const { db } = await createTestDb()
    await runSetup(db, {})

    const created = await createUser(db, {
      email: 'editor@example.com',
      displayName: '',
      passwordHash: 'x',
      roleId: 'admin',
    })

    expect(created.displayName).toBe('')
    expect(created.displayName).not.toContain('@')
  })
})
