import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { ANONYMOUS_STATE, PUBLIC_BASE_URL, login, seedMemberSite } from './helpers'

/**
 * MEMBER-005 — an app signs a site member in.
 *
 * The owner registers an app under Users → Site members → Apps. The test then
 * plays that app the way a desktop app would: it listens on a loopback port,
 * opens the site's sign-in address in the member's browser, and waits for the
 * answer. The member approves on the page the owner built for it (the demo
 * site's "Approve an app" page, seeded under an address prefix of this run),
 * and the app exchanges the code, reads who the member is, and signs out.
 */

// Registering an app asks for step-up, which rotates the session token.
test.use({ storageState: ANONYMOUS_STATE })

const PASSWORD = 'a-long-member-password'

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint: string
  userinfo_endpoint: string
}

/** A loopback listener that resolves with the address the browser is sent back to. */
async function listenForCallback(): Promise<{ server: Server; redirectUri: string; answer: Promise<URL> }> {
  let resolve: (url: URL) => void = () => {}
  const answer = new Promise<URL>((done) => { resolve = done })
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('Back in the app.')
    if (url.pathname === '/callback') resolve(url)
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  return { server, redirectUri: `http://127.0.0.1:${port}/callback`, answer }
}

test('an app signs a member in and reads their access (MEMBER-005)', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const prefix = `p${suffix}-`
  const at = (slug: string) => `${PUBLIC_BASE_URL}/${prefix}${slug}`
  const email = `app-${suffix}@example.com`

  await login(page)
  const admin = page.request
  const site = await seedMemberSite(page, prefix)
  const { headers, emailedLink } = site
  let appId = ''
  const app = await listenForCallback()

  try {
    await test.step('the owner registers the app', async () => {
      await site.stepUp()
      const created = await admin.post('/admin/api/cms/members/apps', {
        headers,
        // Registered without a port: a native app listens on whichever one it gets.
        data: { name: `E2E app ${suffix}`, redirectUris: ['http://127.0.0.1/callback'], scopes: ['profile', 'access'] },
      })
      expect(created.status(), await created.text()).toBe(201)
      appId = ((await created.json()) as { id: string }).id
      expect(appId).toMatch(/^imem_app_/)
    })

    const discovered = await admin.get(`${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server/_instatic/members`)
    expect(discovered.ok()).toBe(true)
    const oauth = (await discovered.json()) as Discovery

    const verifier = randomBytes(48).toString('base64url')
    const state = randomBytes(12).toString('base64url')
    const authorize = new URL(oauth.authorization_endpoint)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: appId,
      redirect_uri: app.redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: 'profile access',
      state,
    }).toString()

    const context = await browser.newContext()
    const visitor = await context.newPage()
    try {
      await test.step('a signed-out visitor is sent to sign in first', async () => {
        await visitor.goto(authorize.toString())
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}sign-in\\?next=`))
      })

      await test.step('the visitor becomes a member', async () => {
        await visitor.goto(at('join'))
        const form = visitor.locator('form').filter({ has: visitor.getByRole('button', { name: 'Create account', exact: true }) })
        await form.getByLabel('Name').fill('Grace')
        await form.getByLabel('Email').fill(email)
        await form.getByLabel('Password').fill(PASSWORD)
        await form.getByRole('button', { name: 'Create account' }).click()
        await expect(visitor.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible({ timeout: 20_000 })
        await visitor.goto(await emailedLink(email))
        await visitor.getByRole('button', { name: 'Confirm my address' }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
      })

      await test.step('the member approves the app on the owner\'s page', async () => {
        await visitor.goto(authorize.toString())
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}approve-app\\?request=`))
        // The page names the app from the stored request.
        await expect(visitor.getByRole('heading', { name: `Sign in to E2E app ${suffix}?` })).toBeVisible()
        await expect(visitor.getByText('Your name and email address')).toBeVisible()
        await visitor.screenshot({ path: '.tmp/evidence/members-approve-app.png' })
        await visitor.getByRole('button', { name: 'Allow', exact: true }).click()
      })

      const callback = await app.answer
      expect(callback.searchParams.get('state')).toBe(state)
      expect(callback.searchParams.get('iss')).toBe(oauth.issuer)
      const code = callback.searchParams.get('code') ?? ''
      expect(code).toMatch(/^imem_ac_/)

      // From here on the app talks to the site itself, with no browser and no cookie.
      const appRequest = await browser.newContext()
      try {
        const exchanged = await appRequest.request.post(oauth.token_endpoint, {
          form: {
            grant_type: 'authorization_code',
            code,
            redirect_uri: app.redirectUri,
            code_verifier: verifier,
            client_id: appId,
            resource: oauth.issuer,
          },
        })
        expect(exchanged.ok(), await exchanged.text()).toBe(true)
        const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string }

        await test.step('the app reads who signed in', async () => {
          const res = await appRequest.request.get(oauth.userinfo_endpoint, {
            headers: { authorization: `Bearer ${tokens.access_token}` },
          })
          expect(res.ok()).toBe(true)
          const member = (await res.json()) as { email: string; name: string; tags: unknown[] }
          expect(member.email).toBe(email)
          expect(member.name).toBe('Grace')
          expect(member.tags).toEqual([])
        })

        await test.step('the code works once', async () => {
          const again = await appRequest.request.post(oauth.token_endpoint, {
            form: {
              grant_type: 'authorization_code', code, redirect_uri: app.redirectUri,
              code_verifier: verifier, client_id: appId, resource: oauth.issuer,
            },
          })
          expect(again.status()).toBe(400)
        })

        await test.step('the app signs out', async () => {
          const revoked = await appRequest.request.post(oauth.revocation_endpoint, {
            form: { token: tokens.refresh_token, client_id: appId },
          })
          expect(revoked.ok()).toBe(true)
          const after = await appRequest.request.get(oauth.userinfo_endpoint, {
            headers: { authorization: `Bearer ${tokens.access_token}` },
          })
          expect(after.status()).toBe(401)
        })
      } finally {
        await appRequest.close()
      }
    } finally {
      await context.close()
    }
  } finally {
    app.server.close()
    if (appId) {
      await site.stepUp()
      await admin.delete(`/admin/api/cms/members/apps/${appId}`, { headers })
    }
    await site.remove()
  }
})
