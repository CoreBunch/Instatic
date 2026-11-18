/**
 * First-run setup seeds the font role tokens into the new site's shell, while
 * a shell that already exists without settings keeps reading without them:
 * upgrading never injects tokens into a live site.
 */
import { describe, expect, it } from 'bun:test'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createSite } from '../../../server/repositories/setup'
import { getDraftSite } from '../../../server/repositories/site'
import { createTestDb } from '../helpers/createTestDb'

async function runSetup(db: DbClient): Promise<Response> {
  return await handleCmsRequest(
    new Request('http://localhost/admin/api/cms/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteName: 'Test', email: 'owner@example.com', password: 'long-enough-password' }),
    }),
    db,
  )
}

describe('setup font role tokens', () => {
  it('seeds font-heading, font-body and font-mono into a brand-new site', async () => {
    const { db } = await createTestDb()
    expect((await runSetup(db)).status).toBe(201)

    const shell = await getDraftSite(db, MAIN_SCOPE)
    const tokens = shell?.settings.fonts?.tokens ?? []
    expect(tokens.map((t) => t.variable)).toEqual(['font-heading', 'font-body', 'font-mono'])
    expect(tokens.every((t) => t.familyId === undefined)).toBe(true)
    expect(shell?.settings.shortcuts).toEqual({})
  })

  it('does not add tokens to an existing shell stored without settings', async () => {
    const { db } = await createTestDb()
    await createSite(db, 'Existing', {})

    const shell = await getDraftSite(db, MAIN_SCOPE)
    expect(shell?.settings.fonts).toBeUndefined()
  })
})
