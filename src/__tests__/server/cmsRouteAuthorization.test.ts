import { describe, expect, it } from 'bun:test'
import type { CoreCapability } from '../../../server/auth/capabilities'
import { createSession } from '../../../server/auth/sessions'
import { createSessionToken, hashSessionToken, SESSION_COOKIE_NAME, sessionExpiry } from '../../../server/auth/tokens'
import type { DbClient } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'
import { findUserByEmail } from '../../../server/repositories/users'
import { createTestDb } from '../helpers/createTestDb'
import type { SiteDocument, SiteShell } from '@core/page-tree'
import { pageFromRow } from '../../../src/core/data/pageFromRow'
import type { DataRow } from '../../../src/core/data/schemas'

const password = 'long-enough-password'

async function readBody<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

async function request(
  db: DbClient,
  path: string,
  options: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const req = new Request(`http://localhost${path}`, {
    ...options,
    headers,
  })
  if (options.cookie) req.headers.set('cookie', options.cookie)
  return handleCmsRequest(req, db)
}

async function setupOwner(db: DbClient): Promise<string> {
  const res = await request(db, '/admin/api/cms/setup', {
    method: 'POST',
    body: JSON.stringify({
      siteName: 'Authorization Matrix',
      email: 'owner@example.com',
      password,
    }),
  })
  expect(res.status).toBe(201)
  return stepUp(db, await sessionCookieForUser(db, 'owner@example.com'))
}

async function sessionCookieForUser(db: DbClient, email: string): Promise<string> {
  const user = await findUserByEmail(db, email)
  expect(user).not.toBeNull()
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: user!.id,
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

async function stepUp(db: DbClient, cookie: string): Promise<string> {
  const res = await request(db, '/admin/api/cms/auth/step-up', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ password }),
  })
  expect(res.status).toBe(200)
  const steppedCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  expect(steppedCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true)
  return steppedCookie
}

async function createRole(
  db: DbClient,
  ownerCookie: string,
  input: { name: string; slug: string; capabilities: CoreCapability[] },
): Promise<string> {
  const res = await request(db, '/admin/api/cms/roles', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify(input),
  })
  expect(res.status).toBe(201)
  const payload = await readBody<{ role: { id: string } }>(res)
  return payload.role.id
}

async function createUser(
  db: DbClient,
  ownerCookie: string,
  input: { email: string; displayName: string; roleId: string },
): Promise<void> {
  const res = await request(db, '/admin/api/cms/users', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({ ...input, password }),
  })
  expect(res.status).toBe(201)
}

async function currentSiteDocument(db: DbClient, cookie: string): Promise<SiteDocument> {
  const shellRes = await request(db, '/admin/api/cms/site', { method: 'GET', cookie })
  expect(shellRes.status).toBe(200)
  const shellPayload = await readBody<{ site: SiteShell }>(shellRes)
  const pagesRes = await request(db, '/admin/api/cms/pages', { method: 'GET', cookie })
  expect(pagesRes.status).toBe(200)
  const pagesPayload = await readBody<{ rows: DataRow[] }>(pagesRes)
  const pages = (pagesPayload.rows ?? []).map(pageFromRow)
  return { ...shellPayload.site, pages }
}

/**
 * Shell-only incremental body for PUT /admin/api/cms/site-document.
 * `shellBaseSeq: 0` matches every scenario here: the freshly-seeded shell has
 * seq 0, and the later stale-base saves are rejected by the capability diff
 * gate (403, phase 1) before the conflict check would run.
 */
function shellPutBody(site: SiteDocument | SiteShell): string {
  const { pages: _pages, ...shell } = site as SiteDocument
  return JSON.stringify({
    mode: 'incremental',
    site: shell,
    changedPages: [],
    deletedPageIds: [],
    changedComponents: [],
    deletedComponentIds: [],
    changedLayouts: [],
    deletedLayoutIds: [],
    baseSeqs: {},
    shellBaseSeq: 0,
  })
}

describe('CMS route authorization', () => {
  it('lets user managers read role options without letting them edit role definitions', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const ownerCookie = await setupOwner(db)
      const roleId = await createRole(db, ownerCookie, {
        name: 'User Manager',
        slug: 'user-manager',
        capabilities: ['users.manage'],
      })
      await createUser(db, ownerCookie, {
        email: 'user-manager@example.com',
        displayName: 'User Manager',
        roleId,
      })
      const userManagerCookie = await sessionCookieForUser(db, 'user-manager@example.com')

      const listRoles = await request(db, '/admin/api/cms/roles', {
        method: 'GET',
        cookie: userManagerCookie,
      })
      expect(listRoles.status).toBe(200)

      const createRoleAttempt = await request(db, '/admin/api/cms/roles', {
        method: 'POST',
        cookie: userManagerCookie,
        body: JSON.stringify({
          name: 'Escalated',
          slug: 'escalated',
          capabilities: ['roles.manage'],
        }),
      })
      expect(createRoleAttempt.status).toBe(403)
    } finally {
      await cleanup()
    }
  })

  it('requires any of the three site-write capabilities to PUT the draft site document', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const ownerCookie = await setupOwner(db)
      const readOnlyRoleId = await createRole(db, ownerCookie, {
        name: 'Site Viewer',
        slug: 'site-viewer-only',
        capabilities: ['site.read'],
      })
      const styleRoleId = await createRole(db, ownerCookie, {
        name: 'Site Stylist',
        slug: 'site-stylist',
        capabilities: ['site.read', 'site.style.edit'],
      })
      await createUser(db, ownerCookie, {
        email: 'reader@example.com',
        displayName: 'Reader',
        roleId: readOnlyRoleId,
      })
      await createUser(db, ownerCookie, {
        email: 'stylist@example.com',
        displayName: 'Stylist',
        roleId: styleRoleId,
      })

      const readerCookie = await sessionCookieForUser(db, 'reader@example.com')
      const stylistCookie = await sessionCookieForUser(db, 'stylist@example.com')

      const site = await currentSiteDocument(db, ownerCookie)
      // site.read alone is not enough — write is forbidden.
      const readOnlyWrite = await request(db, '/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: readerCookie,
        body: shellPutBody(site),
      })
      expect(readOnlyWrite.status).toBe(403)

      // A no-op save (the document is byte-identical) is allowed for any
      // caller that holds at least one site-write capability — the diff
      // walk finds no changes at all.
      const stylistNoop = await request(db, '/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: stylistCookie,
        body: shellPutBody(site),
      })
      expect(stylistNoop.status).toBe(200)
    } finally {
      await cleanup()
    }
  })

  it('rejects a Client role attempting structural changes', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const ownerCookie = await setupOwner(db)
      const clientRoleId = await createRole(db, ownerCookie, {
        name: 'Test Client',
        slug: 'test-client-role',
        capabilities: ['site.read', 'site.content.edit'],
      })
      await createUser(db, ownerCookie, {
        email: 'client@example.com',
        displayName: 'Client',
        roleId: clientRoleId,
      })
      const clientCookie = await sessionCookieForUser(db, 'client@example.com')
      const site = await currentSiteDocument(db, ownerCookie)
      // Mutate the site-wide SEO copy — that's content category, so a
      // content-only client is allowed.
      const contentEdit = structuredClone(site)
      contentEdit.settings.metaTitle = 'Edited by the copy editor'
      const allowed = await request(db, '/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: clientCookie,
        body: shellPutBody(contentEdit),
      })
      expect(allowed.status).toBe(200)

      // Now mutate a class — that's a style change, which the client may not
      // make. The server rejects with 403.
      const refreshed = await currentSiteDocument(db, ownerCookie)
      const styleEdit = structuredClone(refreshed)
      styleEdit.styleRules['__forbidden__'] = {
        id: '__forbidden__',
        name: 'forbidden',
        kind: 'class',
        selector: '.__forbidden__',
        order: 0,
        styles: {},
        contextStyles: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      const denied = await request(db, '/admin/api/cms/site-document', {
        method: 'PUT',
        cookie: clientCookie,
        body: shellPutBody(styleEdit),
      })
      expect(denied.status).toBe(403)
    } finally {
      await cleanup()
    }
  })

  it('treats runtime preview as page editing work, not site settings work', async () => {
    const { db, cleanup } = await createTestDb()
    try {
      const ownerCookie = await setupOwner(db)
      const pageEditorRoleId = await createRole(db, ownerCookie, {
        name: 'Previewing Page Editor',
        slug: 'previewing-page-editor',
        capabilities: ['site.read', 'pages.edit'],
      })
      await createUser(db, ownerCookie, {
        email: 'page-preview@example.com',
        displayName: 'Page Preview',
        roleId: pageEditorRoleId,
      })
      const pageEditorCookie = await sessionCookieForUser(db, 'page-preview@example.com')

      const site = await currentSiteDocument(db, ownerCookie)
      const preview = await request(db, '/admin/api/cms/runtime/preview', {
        method: 'POST',
        cookie: pageEditorCookie,
        body: JSON.stringify({ site, pageId: site.pages[0].id }),
      })

      expect(preview.status).toBe(200)
    } finally {
      await cleanup()
    }
  })
})
