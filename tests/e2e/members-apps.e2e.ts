import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
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

/** A device key as an app keeps one, and the proofs it signs with it (DPoP, RFC 9449). */
function createDeviceKey(): { thumbprint: string; proof: (method: string, url: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const { x } = publicKey.export({ format: 'jwk' })
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: x ?? '' }
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    thumbprint: createHash('sha256').update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`).digest('base64url'),
    proof(method, url) {
      const signed = `${part({ typ: 'dpop+jwt', alg: 'EdDSA', jwk })}.${part({
        jti: randomBytes(12).toString('base64url'), htm: method, htu: url, iat: Math.floor(Date.now() / 1000),
      })}`
      return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`
    },
  }
}

/** The address the app opens in the member's browser, and what it keeps to finish the sign-in. */
function signInAddress(
  oauth: Discovery,
  appId: string,
  redirectUri: string,
  extra: Record<string, string> = {},
): { authorize: URL; verifier: string; state: string } {
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(12).toString('base64url')
  const authorize = new URL(oauth.authorization_endpoint)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    redirect_uri: redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'profile access',
    state,
    ...extra,
  }).toString()
  return { authorize, verifier, state }
}

/** Sign up on the seeded Join page and confirm by the emailed link; ends on the account page. */
async function becomeMember(
  visitor: Page,
  at: (slug: string) => string,
  emailedLink: (to: string) => Promise<string>,
  email: string,
): Promise<void> {
  await visitor.goto(at('join'))
  const form = visitor.locator('form').filter({ has: visitor.getByRole('button', { name: 'Create account', exact: true }) })
  await form.getByLabel('Name').fill('Grace')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill(PASSWORD)
  await form.getByRole('button', { name: 'Create account' }).click()
  await expect(visitor.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible({ timeout: 20_000 })
  await visitor.goto(await emailedLink(email))
  await visitor.getByRole('button', { name: 'Confirm my address' }).click()
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

    const { authorize, verifier, state } = signInAddress(oauth, appId, app.redirectUri)

    const context = await browser.newContext()
    const visitor = await context.newPage()
    try {
      await test.step('a signed-out visitor is sent to sign in first', async () => {
        await visitor.goto(authorize.toString())
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}sign-in\\?next=`))
      })

      await test.step('the visitor becomes a member', async () => {
        await becomeMember(visitor, at, emailedLink, email)
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

/**
 * MEMBER-006 — a member and an administrator see and end an app's sign-in.
 *
 * After a member allows an app, the account page the owner built lists it
 * (a per-visitor list with a Disconnect form in every row), the member is
 * emailed, and the admin's member panel lists it too. Disconnecting ends the
 * app's access at once.
 */
test('a member and an administrator disconnect a connected app (MEMBER-006)', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const prefix = `q${suffix}-`
  const at = (slug: string) => `${PUBLIC_BASE_URL}/${prefix}${slug}`
  const email = `apps-${suffix}@example.com`
  const appName = `E2E app ${suffix}`

  await login(page)
  const admin = page.request
  const site = await seedMemberSite(page, prefix)
  const { headers, emailedLink } = site
  let appId = ''
  const servers: Server[] = []

  try {
    await site.stepUp()
    const created = await admin.post('/admin/api/cms/members/apps', {
      headers,
      data: { name: appName, redirectUris: ['http://127.0.0.1/callback'], scopes: ['profile', 'access'] },
    })
    expect(created.status(), await created.text()).toBe(201)
    appId = ((await created.json()) as { id: string }).id
    const oauth = (await (
      await admin.get(`${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server/_instatic/members`)
    ).json()) as Discovery

    const context = await browser.newContext()
    const visitor = await context.newPage()
    const appRequest = await browser.newContext()

    /** Play the app once: the member allows it and the app ends up with an access token. */
    async function connect(): Promise<string> {
      const app = await listenForCallback()
      servers.push(app.server)
      const { authorize, verifier } = signInAddress(oauth, appId, app.redirectUri)
      await visitor.goto(authorize.toString())
      await visitor.getByRole('button', { name: 'Allow', exact: true }).click()
      const code = (await app.answer).searchParams.get('code') ?? ''
      const exchanged = await appRequest.request.post(oauth.token_endpoint, {
        form: {
          grant_type: 'authorization_code', code, redirect_uri: app.redirectUri,
          code_verifier: verifier, client_id: appId, resource: oauth.issuer,
        },
      })
      expect(exchanged.ok(), await exchanged.text()).toBe(true)
      return ((await exchanged.json()) as { access_token: string }).access_token
    }
    const userinfo = (token: string) =>
      appRequest.request.get(oauth.userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } })

    try {
      await becomeMember(visitor, at, emailedLink, email)
      await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
      const apps = visitor.locator('[data-demo="apps"]')

      await test.step('the account page lists nothing before an app is signed in', async () => {
        await expect(visitor.getByRole('heading', { name: 'Connected apps' })).toBeVisible()
        await expect(apps.locator('[data-demo="app"]')).toHaveCount(0)
      })

      const first = await connect()
      expect((await userinfo(first)).status()).toBe(200)

      await test.step('the member is told by email', async () => {
        await expect
          .poll(async () => {
            const res = await admin.get(`/admin/api/cms/mail/activity?period=24h&q=${encodeURIComponent(email)}`)
            const { entries } = (await res.json()) as { entries: Array<{ to: string; body: string | null }> }
            return entries.some((entry) => entry.to === email && (entry.body ?? '').includes(appName))
          }, { timeout: 20_000 })
          .toBe(true)
      })

      await test.step('the member disconnects the app on the account page', async () => {
        await visitor.goto(at('account'))
        const row = apps.locator('[data-demo="app"]')
        await expect(row).toHaveCount(1)
        await expect(row.getByRole('heading', { name: appName })).toBeVisible()
        await expect(row.getByText(/Connected \d{4}-\d{2}-\d{2}\. Last used \d{4}-\d{2}-\d{2}\./)).toBeVisible()
        await visitor.screenshot({ path: '.tmp/evidence/members-connected-apps.png', fullPage: true })
        await row.getByRole('button', { name: 'Disconnect', exact: true }).click()
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))
        await expect(apps.locator('[data-demo="app"]')).toHaveCount(0)
        expect((await userinfo(first)).status()).toBe(401)
      })

      const second = await connect()
      expect((await userinfo(second)).status()).toBe(200)

      await test.step('an administrator disconnects it from the member panel', async () => {
        await page.goto('/admin/users')
        await page.getByRole('tab', { name: 'Site members', exact: true }).click()
        const tab = page.getByRole('region', { name: 'Site members' })
        await tab.getByRole('list', { name: 'Site members' }).getByRole('button').filter({ hasText: email }).click()
        const details = page.getByRole('article', { name: 'Member details' })
        const connected = details.getByRole('region', { name: 'Connected apps' })
        await expect(connected.getByText(appName, { exact: true })).toBeVisible()
        await page.screenshot({ path: '.tmp/evidence/members-admin-connected-apps.png' })
        await connected.getByRole('button', { name: `Disconnect ${appName}` }).click()
        await expect(connected.getByText('No apps are signed in to this account.')).toBeVisible()
        expect((await userinfo(second)).status()).toBe(401)
      })
    } finally {
      await appRequest.close()
      await context.close()
    }
  } finally {
    for (const server of servers) server.close()
    if (appId) {
      await site.stepUp()
      await admin.delete(`/admin/api/cms/members/apps/${appId}`, { headers })
    }
    await site.remove()
  }
})

/**
 * MEMBER-007 — an app binds its sign-in to a device.
 *
 * The app keeps a device key. Its sign-in is bound to that key, so the code
 * and the refresh token are useless without it, and nobody without it can
 * sign the device out.
 */
test('an app binds its sign-in to a device (MEMBER-007)', async ({ page, browser }) => {
  test.setTimeout(240_000)
  const suffix = Date.now().toString(36)
  const prefix = `r${suffix}-`
  const at = (slug: string) => `${PUBLIC_BASE_URL}/${prefix}${slug}`
  const email = `device-${suffix}@example.com`
  const appName = `E2E app ${suffix}`
  const deviceName = `Laptop ${suffix}`

  await login(page)
  const admin = page.request
  const site = await seedMemberSite(page, prefix)
  const { headers, emailedLink } = site
  let appId = ''
  const app = await listenForCallback()

  try {
    await site.stepUp()
    const created = await admin.post('/admin/api/cms/members/apps', {
      headers,
      data: { name: appName, redirectUris: ['http://127.0.0.1/callback'], scopes: ['profile', 'access'] },
    })
    expect(created.status(), await created.text()).toBe(201)
    appId = ((await created.json()) as { id: string }).id
    const oauth = (await (
      await admin.get(`${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server/_instatic/members`)
    ).json()) as Discovery

    const device = createDeviceKey()
    const { authorize, verifier } = signInAddress(oauth, appId, app.redirectUri, {
      dpop_jkt: device.thumbprint, device_name: deviceName,
    })
    const context = await browser.newContext()
    const visitor = await context.newPage()
    const appRequest = await browser.newContext()
    try {
      await becomeMember(visitor, at, emailedLink, email)
      await expect(visitor).toHaveURL(new RegExp(`/${prefix}account$`))

      await test.step('the approval page names the device', async () => {
        await visitor.goto(authorize.toString())
        await expect(visitor).toHaveURL(new RegExp(`/${prefix}approve-app\\?request=`))
        await expect(visitor.getByText(`It runs on ${deviceName}`)).toBeVisible()
        await visitor.getByRole('button', { name: 'Allow', exact: true }).click()
      })
      const code = (await app.answer).searchParams.get('code') ?? ''
      const exchange = (proof?: string) => appRequest.request.post(oauth.token_endpoint, {
        headers: proof ? { dpop: proof } : {},
        form: {
          grant_type: 'authorization_code', code, redirect_uri: app.redirectUri,
          code_verifier: verifier, client_id: appId, resource: oauth.issuer,
        },
      })

      let tokens = { access_token: '', refresh_token: '' }
      await test.step('the code works only with a proof from the device key', async () => {
        expect((await exchange()).status()).toBe(400)
        expect((await exchange(createDeviceKey().proof('POST', oauth.token_endpoint))).status()).toBe(400)
        const exchanged = await exchange(device.proof('POST', oauth.token_endpoint))
        expect(exchanged.ok(), await exchanged.text()).toBe(true)
        tokens = (await exchanged.json()) as { access_token: string; refresh_token: string }
      })

      await test.step('a copied refresh token does nothing without the key', async () => {
        const refresh = (proof?: string) => appRequest.request.post(oauth.token_endpoint, {
          headers: proof ? { dpop: proof } : {},
          form: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: appId, resource: oauth.issuer },
        })
        expect((await refresh()).status()).toBe(400)
        const mine = await refresh(device.proof('POST', oauth.token_endpoint))
        expect(mine.ok(), await mine.text()).toBe(true)
        tokens = (await mine.json()) as { access_token: string; refresh_token: string }
      })

      await test.step('only the device can sign itself out', async () => {
        const userinfo = () => appRequest.request.get(oauth.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        })
        const revoke = (proof?: string) => appRequest.request.post(oauth.revocation_endpoint, {
          headers: proof ? { dpop: proof } : {},
          form: { token: tokens.refresh_token, client_id: appId },
        })
        // A copy of the token is not enough; the answer does not say so.
        expect((await revoke()).status()).toBe(200)
        expect((await userinfo()).status()).toBe(200)
        await visitor.goto(at('account'))
        await expect(visitor.getByRole('heading', { name: `${appName} on ${deviceName}` })).toBeVisible()
        expect((await revoke(device.proof('POST', oauth.revocation_endpoint))).status()).toBe(200)
        expect((await userinfo()).status()).toBe(401)
      })
    } finally {
      await appRequest.close()
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
