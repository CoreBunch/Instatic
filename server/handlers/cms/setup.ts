/**
 * First-run setup endpoints + public site identity.
 *
 *   GET  /admin/api/cms/setup/status — does the install need setup?
 *   POST /admin/api/cms/setup        — create site + first owner + a
 *                                       starter homepage in one transaction.
 *   GET  /admin/api/cms/public-site  — site name + favicon URL exposed
 *                                       without auth so the login / setup
 *                                       screen can render the configured
 *                                       brand instead of the default mark.
 *
 * The setup POST is a one-shot bootstrap: it 409s if anyone has already
 * run setup, so the endpoint can stay public without becoming an account
 * creation backdoor. The `public-site` GET only exposes the two fields
 * that are already rendered on every published page (site name, favicon),
 * so it adds no new information leak.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../../db/client'
import { hashPassword } from '../../auth/tokens'
import { createSite, getSetupStatus } from '../../repositories/setup'
import { createUser } from '../../repositories/users'
import { createAuditEvent } from '../../repositories/audit'
import { createDataRow } from '../../repositories/data'
import { createNode } from '@core/page-tree'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import type { Page } from '@core/page-tree'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import type { SiteRow } from '../../types'
import { CMS_API_PREFIX, requestAuditContext } from './shared'
import {
  notifyRowWrite,
  notifyShellWrite,
  serializeCollabAwareWrite,
} from '../../repositories/rowWriteEvents'

export async function handleSetupRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/setup/status`) {
    if (req.method !== 'GET') return methodNotAllowed()
    return jsonResponse(await getSetupStatus(db))
  }

  if (url.pathname === `${CMS_API_PREFIX}/public-site`) {
    if (req.method !== 'GET') return methodNotAllowed()
    return jsonResponse(await loadPublicSiteIdentity(db))
  }

  if (url.pathname === `${CMS_API_PREFIX}/setup`) {
    if (req.method !== 'POST') return methodNotAllowed()
    const status = await getSetupStatus(db)
    if (!status.needsSetup) {
      return jsonResponse({ error: 'Setup already complete' }, { status: 409 })
    }

    const SetupBodySchema = Type.Object({
      siteName: Type.String(),
      email: Type.String(),
      password: Type.String(),
      // Optional: the owner's public name. Left empty, author bindings render
      // nothing rather than the email address.
      displayName: Type.Optional(Type.String()),
    })
    const body = await readValidatedBody(req, SetupBodySchema)
    if (!body) return badRequest('Invalid request body')
    const siteName = body.siteName.trim()
    const email = body.email.trim().toLowerCase()
    const password = body.password.trim()
    const displayName = body.displayName?.trim() ?? ''

    if (!siteName) return badRequest('Missing siteName')
    if (!email.includes('@')) return badRequest('Invalid email')
    if (password.length < 12) return badRequest('Password must be at least 12 characters')

    return serializeCollabAwareWrite(async () => {
      let homePageId = ''
      const response = await db.transaction(async (tx) => {
        await createSite(tx, siteName, {})
        const owner = await createUser(tx, {
          id: nanoid(),
          email,
          displayName,
          passwordHash: await hashPassword(password),
          roleId: 'owner',
          allowOwnerRole: true,
        })
        await createAuditEvent(tx, {
          actorUserId: null,
          action: 'user.create',
          targetType: 'user',
          targetId: owner.id,
          metadata: { roleId: 'owner', source: 'setup' },
          ...requestAuditContext(req),
        })
        // Seed a starter homepage as a data_row in the 'pages' system table.
        const rootNode = createNode('base.body')
        const homePage: Page = {
          id: nanoid(),
          title: 'Home',
          slug: 'index',
          nodes: { [rootNode.id]: rootNode },
          rootNodeId: rootNode.id,
        }
        homePageId = homePage.id
        await createDataRow(
          tx,
          { id: homePage.id, tableId: 'pages', cells: pageToCells(homePage), slug: homePage.slug },
          owner.id,
          null,
          { collabInternal: true },
        )
        return jsonResponse({ ok: true }, { status: 201 })
      })
      notifyShellWrite()
      notifyRowWrite({ tableId: 'pages', rowIds: [homePageId], kind: 'create' })
      return response
    })
  }

  return null
}

interface PublicSiteIdentity {
  name: string | null
  faviconUrl: string | null
}

/**
 * Persisted `site.settings_json` envelope, narrowed to the ONE field the
 * public identity endpoint reads. The shell's settings are stored under
 * `{ site: { settings: SiteSettings } }` (see `shellToStorage` in
 * `server/repositories/site.ts`), but modelling the full `SiteSettings` shape
 * here would be wrong: its `shortcuts` field is required (backfilled by
 * `parseSiteSettings`, not guaranteed in raw storage) and its `framework` /
 * `fonts` sub-schemas drift independently — any of which would make a valid
 * favicon resolve to null. TypeBox objects allow extra properties by default,
 * so validating only `faviconUrl` still type-checks it with zero `as` casts
 * while staying immune to unrelated settings fields. Every level is optional
 * so a freshly-created site (`settings_json = {}`) yields a null favicon
 * instead of throwing.
 */
const StoredSiteIdentitySchema = Type.Object({
  site: Type.Optional(
    Type.Object({
      settings: Type.Optional(
        Type.Object({
          faviconUrl: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),
})

/**
 * Read the site identity (name + favicon URL) the unauthenticated login /
 * setup screen renders as its brand. Never throws: a missing site row or
 * malformed settings JSON resolves to `{ name: null, faviconUrl: null }`,
 * which the client falls back to the default mark.
 *
 * Only the two fields published pages already expose are returned — no
 * page tree, no plugin list, no user info — so this stays safe to serve
 * without auth.
 */
async function loadPublicSiteIdentity(db: DbClient): Promise<PublicSiteIdentity> {
  const { rows } = await db<SiteRow>`
    select id, name, settings_json, created_at, updated_at
    from site
    where id = 'default'
    limit 1
  `
  const row = rows[0]
  if (!row) return { name: null, faviconUrl: null }

  // Validate at the boundary, then trust the parsed value. A malformed
  // settings payload fails parsing and resolves to a null favicon — never a
  // thrown error or a silently-wrong value.
  const parsed = safeParseValue(StoredSiteIdentitySchema, row.settings_json)
  const faviconUrl = parsed.ok ? parsed.value.site?.settings?.faviconUrl ?? null : null

  return {
    name: typeof row.name === 'string' && row.name.length > 0 ? row.name : null,
    faviconUrl,
  }
}
