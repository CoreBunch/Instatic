import { strToU8, zipSync } from 'fflate'
import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, PUBLIC_BASE_URL, login, seedMemberSite } from './helpers'

/**
 * MEMBER-004 — a plugin's routes for site members, from a real browser.
 *
 * The owner installs a plugin that registers a route for signed-in members,
 * one that also needs a tag, and a public one. A visitor is refused while
 * signed out, accepts an invitation on the site's invitation page, reaches
 * the member route as themselves, and reaches the tag route only once the
 * owner grants the tag. The plugin never sees the member's session cookie.
 */

// Installing a plugin and deleting a member ask for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

const PLUGIN_SOURCE = `
  export function activate(api) {
    api.cms.routes.public.get('/who', (ctx) => ({ member: ctx.member ? ctx.member.email : null }))
    api.cms.routes.member.get('/me', (ctx) => ({
      email: ctx.member.email,
      tags: ctx.member.tags,
      cookie: ctx.req.headers.get('cookie'),
    }))
    api.cms.routes.member.get('/lounge', { tag: 'pro' }, (ctx) => ({ welcome: ctx.member.email }))
    api.cms.routes.member.post('/note', (ctx) => ({ saved: ctx.body.text, by: ctx.member.email }))
  }
`

test('a plugin serves routes only signed-in members reach (MEMBER-004)', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const pluginId = `e2e.club-${suffix}`
  const mount = `${PUBLIC_BASE_URL}/_instatic/plugins/${pluginId}`
  const email = `guest-${suffix}@example.com`
  const permissions = ['cms.routes', 'cms.routes.public', 'members.read']

  await login(page)
  const admin = page.request
  // An invitation opens a page of the site, so the site needs its member pages.
  const site = await seedMemberSite(page, `p${suffix}-`)
  const { headers, stepUp, emailedLink } = site
  let memberId: string | null = null

  try {
    await test.step('install the plugin', async () => {
      await stepUp()
      const manifest = {
        id: pluginId,
        name: 'E2E Club',
        version: '1.0.0',
        apiVersion: 1,
        permissions,
        entrypoints: { server: 'server/index.js' },
        resources: [],
        adminPages: [],
      }
      const installed = await admin.post('/admin/api/cms/plugins/package', {
        headers,
        multipart: {
          file: {
            name: `${pluginId}.zip`,
            mimeType: 'application/zip',
            buffer: Buffer.from(zipSync({
              'plugin.json': strToU8(JSON.stringify(manifest)),
              'server/index.js': strToU8(PLUGIN_SOURCE),
            })),
          },
          grantedPermissions: JSON.stringify(permissions),
        },
      })
      expect(installed.ok(), await installed.text()).toBe(true)
    })

    const context = await browser.newContext()
    const visitor = await context.newPage()
    try {
      await test.step('a signed-out visitor is refused the member route', async () => {
        await expect.poll(async () => (await context.request.get(`${mount}/who`)).status(), {
          message: 'the plugin is up',
          timeout: 20_000,
        }).toBe(200)
        expect(await (await context.request.get(`${mount}/who`)).json()).toEqual({ member: null })
        const refused = await context.request.get(`${mount}/me`)
        expect(refused.status()).toBe(401)
        expect(refused.headers()['cache-control']).toContain('no-store')
      })

      await test.step('the visitor accepts an invitation', async () => {
        const invited = await admin.post('/admin/api/cms/members/invite', { headers, data: { email } })
        expect(invited.ok(), await invited.text()).toBe(true)
        memberId = ((await invited.json()) as { member: { id: string } }).member.id

        // The link opens the site's invitation page, where the visitor chooses a password.
        await visitor.goto(await emailedLink(email))
        await expect(visitor).toHaveURL(new RegExp(`${site.path('invitation')}\\?`))
        await visitor.getByLabel('New password').fill('a-long-enough-password')
        await visitor.getByRole('button', { name: 'Create account' }).click()
        await expect(visitor).toHaveURL(new RegExp(`${site.path('account')}$`))
      })

      await test.step('the member reaches the route as themselves', async () => {
        await visitor.goto(`${mount}/me`)
        const me = JSON.parse(await visitor.locator('body').innerText()) as { email: string; tags: string[]; cookie: string | null }
        expect(me.email).toBe(email)
        expect(me.tags).toEqual([])
        // The session cookie stays with the site; the plugin is only told who the member is.
        expect(me.cookie ?? '').not.toContain('instatic_member')
        expect(await (await context.request.get(`${mount}/who`)).json()).toEqual({ member: email })

        // A write is accepted from a page of the site.
        const note = await visitor.evaluate(async (url) => {
          const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) })
          return { status: res.status, body: await res.json() }
        }, `${mount}/note`)
        expect(note).toEqual({ status: 200, body: { saved: 'hello', by: email } })
      })

      await test.step('the tag route opens once the owner grants the tag', async () => {
        expect((await context.request.get(`${mount}/lounge`)).status()).toBe(403)
        const granted = await admin.post(`/admin/api/cms/members/${memberId}/tags`, { headers, data: { tag: 'pro' } })
        expect(granted.ok(), await granted.text()).toBe(true)
        const lounge = await context.request.get(`${mount}/lounge`)
        expect(lounge.status()).toBe(200)
        expect(await lounge.json()).toEqual({ welcome: email })
      })

      await test.step('a suspended member is refused at once', async () => {
        const suspended = await admin.post(`/admin/api/cms/members/${memberId}/suspend`, { headers })
        expect(suspended.ok(), await suspended.text()).toBe(true)
        expect((await context.request.get(`${mount}/me`)).status()).toBe(401)
      })
    } finally {
      await context.close()
    }
  } finally {
    // The suite shares one site: leave neither the member nor the plugin behind.
    await stepUp()
    if (memberId) await admin.delete(`/admin/api/cms/members/${memberId}`, { headers })
    const removed = await admin.delete(`/admin/api/cms/plugins/${pluginId}?force=true`, { headers })
    expect(removed.ok(), await removed.text()).toBe(true)
    await site.remove()
  }
})
