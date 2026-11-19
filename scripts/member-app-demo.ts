/**
 * A sample app that signs a site member in, from a terminal.
 *
 * It does what Instatic Desktop does: opens the site's sign-in address in the
 * browser, listens on a loopback port for the answer, exchanges the code for
 * tokens (PKCE, no client secret), then reads who the member is and which
 * tags they hold. It also keeps a device key: the sign-in is bound to it, so
 * the code exchange, every refresh and signing out carry a proof signed with
 * that key (DPoP, RFC 9449). Nothing is stored; the app signs out again at
 * the end. A real app keeps the device key in the OS keychain.
 *
 *   bun run demo:member-app -- --site http://127.0.0.1:3040 --app imem_app_…
 *
 * The app must be registered on the site (Users → Site members → Apps) with
 * the redirect address `http://127.0.0.1/callback`; the port is free to vary.
 * `bun run demo:members` registers one and prints this command.
 */
import { hostname } from 'node:os'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (!value) {
    console.error(`[member-app-demo] missing --${name}. Usage: --site <origin> --app <client id> [--no-open]`)
    process.exit(2)
  }
  return value
}

const SITE = argument('site').replace(/\/+$/, '')
const APP_ID = argument('app')
const ISSUER = `${SITE}/_instatic/members`

const TokenResponseSchema = Type.Object({
  access_token: Type.String(),
  refresh_token: Type.String(),
  expires_in: Type.Number(),
  scope: Type.String(),
})

const UserinfoSchema = Type.Object({
  id: Type.String(),
  serverTime: Type.String(),
  email: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.Object({
    tag: Type.String(),
    expiresAt: Type.Union([Type.String(), Type.Null()]),
  }))),
})

function base64Url(bytes: Uint8Array | ArrayBuffer | string): string {
  return Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)).toString('base64url')
}

// ── The device key ──────────────────────────────────────────────────────────
// Made fresh for this run. Its thumbprint (RFC 7638) is how the site names it.
const deviceKey = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
const exportedDeviceKey = await crypto.subtle.exportKey('jwk', deviceKey.publicKey)
const deviceJwk = { kty: 'OKP', crv: 'Ed25519', x: exportedDeviceKey.x ?? '' }
const deviceThumbprint = base64Url(await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(`{"crv":"${deviceJwk.crv}","kty":"${deviceJwk.kty}","x":"${deviceJwk.x}"}`),
))

/** A proof that this request comes from the holder of the device key. One per request. */
async function dpopProof(method: string, url: string): Promise<string> {
  const header = base64Url(JSON.stringify({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: deviceJwk }))
  const claims = base64Url(JSON.stringify({
    jti: crypto.randomUUID(), htm: method, htu: url, iat: Math.floor(Date.now() / 1000),
  }))
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, deviceKey.privateKey, new TextEncoder().encode(`${header}.${claims}`))
  return `${header}.${claims}.${base64Url(signature)}`
}

function log(line: string): void {
  process.stdout.write(`${line}\n`)
}

async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
  const url = `${ISSUER}/oauth/${path}`
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: await dpopProof('POST', url) },
    body: new URLSearchParams(fields).toString(),
  })
}

async function readTokens(res: Response, step: string) {
  const raw: unknown = await res.json()
  const parsed = safeParseValue(TokenResponseSchema, raw)
  if (!res.ok || !parsed.ok) {
    console.error(`[member-app-demo] ${step} failed (${res.status}):`, raw)
    process.exit(1)
  }
  return parsed.value
}

// ── 1. Ask the member, in their browser ─────────────────────────────────────
const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)))
const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
const state = base64Url(crypto.getRandomValues(new Uint8Array(16)))

let answer: (url: URL) => void = () => {}
const answered = new Promise<URL>((resolve) => { answer = resolve })

const listener = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== '/callback') return new Response('Not found', { status: 404 })
    answer(url)
    return new Response('You can close this tab and go back to the terminal.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
})
const redirectUri = `http://127.0.0.1:${listener.port}/callback`

const authorize = new URL(`${ISSUER}/oauth/authorize`)
authorize.search = new URLSearchParams({
  response_type: 'code',
  client_id: APP_ID,
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  scope: 'profile access',
  state,
  // Bind the sign-in to this device's key, and say what to call the device.
  dpop_jkt: deviceThumbprint,
  device_name: hostname(),
}).toString()

log('Open this address in your browser, sign in as a member and allow the app:')
log(`  ${authorize}`)
if (!process.argv.includes('--no-open') && process.platform === 'darwin') {
  Bun.spawn(['open', authorize.toString()])
}

const callback = await answered
await listener.stop()

const error = callback.searchParams.get('error')
if (error) {
  console.error(`[member-app-demo] the site answered "${error}": ${callback.searchParams.get('error_description') ?? ''}`)
  process.exit(1)
}
// The answer must be for this request and from this site, or it is not ours.
if (callback.searchParams.get('state') !== state || callback.searchParams.get('iss') !== ISSUER) {
  console.error('[member-app-demo] the answer does not belong to this sign-in. Stopping.')
  process.exit(1)
}

// ── 2. Exchange the code ────────────────────────────────────────────────────
const tokens = await readTokens(await postForm('token', {
  grant_type: 'authorization_code',
  code: callback.searchParams.get('code') ?? '',
  redirect_uri: redirectUri,
  code_verifier: verifier,
  client_id: APP_ID,
  resource: ISSUER,
}), 'the code exchange')
log('')
log(`Signed in. The access token lasts ${Math.round(tokens.expires_in / 60)} minutes; scope "${tokens.scope}".`)

// ── 3. Read who the member is ───────────────────────────────────────────────
const userinfoResponse = await fetch(`${ISSUER}/oauth/userinfo`, {
  headers: { authorization: `Bearer ${tokens.access_token}` },
})
const userinfo = safeParseValue(UserinfoSchema, await userinfoResponse.json())
if (!userinfoResponse.ok || !userinfo.ok) {
  console.error(`[member-app-demo] reading the member failed (${userinfoResponse.status}).`)
  process.exit(1)
}
const member = userinfo.value
log(`Member:  ${member.name || '(no name)'} <${member.email ?? 'email not shared'}>`)
const tags = member.tags ?? []
log(tags.length === 0
  ? 'Tags:    none'
  : `Tags:    ${tags.map((entry) => `${entry.tag} (${entry.expiresAt ? `until ${entry.expiresAt}` : 'no end date'})`).join(', ')}`)
log(`An app gating on the tag "pro" would ${tags.some((entry) => entry.tag === 'pro') ? 'open' : 'show its renew screen'}.`)

// ── 4. Refresh once, then sign out ──────────────────────────────────────────
const refreshed = await readTokens(await postForm('token', {
  grant_type: 'refresh_token',
  refresh_token: tokens.refresh_token,
  client_id: APP_ID,
  resource: ISSUER,
}), 'the refresh')
log('Refreshed: the old refresh token is spent and a new pair was issued.')

await postForm('revoke', { token: refreshed.refresh_token, client_id: APP_ID })
const after = await fetch(`${ISSUER}/oauth/userinfo`, { headers: { authorization: `Bearer ${refreshed.access_token}` } })
log(`Signed out: the site now answers ${after.status} to the old token.`)
process.exit(0)
