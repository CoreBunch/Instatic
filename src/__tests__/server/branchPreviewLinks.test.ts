/**
 * Branch preview links — issuing, the cookie handshake, rendering the
 * branch's draft on the public site, and revocation.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { handleServerRequest } from '../../../server/router'
import { listDataRows, saveDataRowDraft } from '../../../server/repositories/data'
import {
  createCapabilityTestHarness,
  expectForbidden,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

const BRANCHES = '/admin/api/cms/branches'
const PUBLIC_ORIGIN = 'http://localhost'

function publicRequest(path: string, cookie?: string): Request {
  const req = new Request(`${PUBLIC_ORIGIN}${path}`, { redirect: 'manual' })
  if (cookie) req.headers.set('cookie', cookie)
  return req
}

function cookieFrom(res: Response): string {
  const header = res.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

describe('branch preview links', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('issues a link, renders the branch draft behind the cookie, and stops after revocation', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Preview Me' } })).status).toBe(201)

    // Give the branch a home page title main does not have.
    const scope = { branchId: 'preview-me' }
    const [home] = await listDataRows(harness.db, scope, 'pages')
    expect(home).toBeDefined()
    await saveDataRowDraft(harness.db, scope, home!.id, {
      cells: { ...home!.cells, title: 'Branch-only headline' },
      slug: home!.slug,
    })

    const none = await readJson<{ preview: unknown }>(
      await harness.cms(`${BRANCHES}/preview-me/preview`, { cookie: owner }),
    )
    expect(none.preview).toBeNull()

    const issued = await harness.cms(`${BRANCHES}/preview-me/preview`, { method: 'POST', cookie: owner })
    expect(issued.status).toBe(201)
    const { url, preview } = await readJson<{ url: string; preview: { branchId: string } }>(issued)
    expect(preview.branchId).toBe('preview-me')
    expect(url).toMatch(/\/_instatic\/preview\/[A-Za-z0-9_-]{20,}$/)

    const active = await readJson<{ preview: { id: string } | null }>(
      await harness.cms(`${BRANCHES}/preview-me/preview`, { cookie: owner }),
    )
    expect(active.preview).not.toBeNull()

    // Entering the link sets the cookie and lands on the root.
    const entry = await handleServerRequest(publicRequest(new URL(url).pathname), { db: harness.db })
    expect(entry.status).toBe(302)
    expect(entry.headers.get('location')).toBe('/')
    const cookie = cookieFrom(entry)
    expect(cookie.startsWith('instatic_branch_preview=')).toBe(true)
    expect(entry.headers.get('set-cookie')).toContain('HttpOnly')

    // With the cookie the root renders the branch draft, banner included.
    const previewed = await handleServerRequest(publicRequest('/', cookie), { db: harness.db })
    expect(previewed.status).toBe(200)
    expect(previewed.headers.get('cache-control')).toBe('no-store')
    expect(previewed.headers.get('x-robots-tag')).toBe('noindex')
    const html = await previewed.text()
    expect(html).toContain('Branch-only headline')
    expect(html).toContain('Previewing branch <strong>Preview Me</strong>')
    expect(html).toContain('/_instatic/preview/exit')

    // Without the cookie nothing is published yet, so the root is not the branch.
    const plain = await handleServerRequest(publicRequest('/'), { db: harness.db })
    expect(plain.status).not.toBe(200)

    // Exit clears the cookie.
    const exit = await handleServerRequest(publicRequest('/_instatic/preview/exit', cookie), { db: harness.db })
    expect(exit.status).toBe(302)
    expect(exit.headers.get('set-cookie')).toContain('Max-Age=0')

    // Revoking retires the link: the cookie no longer opens the branch.
    const revoked = await harness.cms(`${BRANCHES}/preview-me/preview`, { method: 'DELETE', cookie: owner })
    expect(revoked.status).toBe(200)
    const afterRevoke = await handleServerRequest(publicRequest('/', cookie), { db: harness.db })
    expect(afterRevoke.status).not.toBe(200)
    const deadEntry = await handleServerRequest(publicRequest(new URL(url).pathname), { db: harness.db })
    expect(deadEntry.status).toBe(302)
    expect(deadEntry.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('rotates the link on every share and gates issuing on site.branches.manage', async () => {
    harness = await createCapabilityTestHarness()
    const owner = await harness.setupOwner()
    expect((await harness.cms(BRANCHES, { method: 'POST', cookie: owner, json: { name: 'Rotate' } })).status).toBe(201)

    const first = await readJson<{ url: string }>(
      await harness.cms(`${BRANCHES}/rotate/preview`, { method: 'POST', cookie: owner }),
    )
    const second = await readJson<{ url: string }>(
      await harness.cms(`${BRANCHES}/rotate/preview`, { method: 'POST', cookie: owner }),
    )
    expect(second.url).not.toBe(first.url)
    const stale = await handleServerRequest(publicRequest(new URL(first.url).pathname), { db: harness.db })
    expect(stale.headers.get('set-cookie')).toContain('Max-Age=0')
    const fresh = await handleServerRequest(publicRequest(new URL(second.url).pathname), { db: harness.db })
    expect(fresh.headers.get('set-cookie')).not.toContain('Max-Age=0')

    const reader = await harness.createRoleUser({ name: 'Reader', slug: 'reader', capabilities: ['site.read'] })
    expect((await harness.cms(`${BRANCHES}/rotate/preview`, { cookie: reader.cookie })).status).toBe(200)
    await expectForbidden(await harness.cms(`${BRANCHES}/rotate/preview`, { method: 'POST', cookie: reader.cookie }))
    await expectForbidden(await harness.cms(`${BRANCHES}/rotate/preview`, { method: 'DELETE', cookie: reader.cookie }))

    expect((await harness.cms(`${BRANCHES}/main/preview`, { method: 'POST', cookie: owner })).status).toBe(400)
  })
})
