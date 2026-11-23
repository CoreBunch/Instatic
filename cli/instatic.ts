#!/usr/bin/env bun
import manifest from './package.json' with { type: 'json' }
import { parseArgs } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2), allowPositionals: true,
  options: {
    account: { type: 'string' }, branch: { type: 'string' }, file: { type: 'string' }, upload: { type: 'string' },
    json: { type: 'string' }, out: { type: 'string' }, viewport: { type: 'string' },
    'no-open': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
  },
})
function output(text: string) {
  process.stdout.write(text + '\n')
}

const help = `Instatic CLI
  instatic connect SITE --account ID          Authorize this machine in your browser
  instatic whoami                             Show the current grant
  instatic api lookup [SEARCH]                Search the site's operation guide
  instatic api describe METHOD PATH          Inspect one documented operation and its input
  instatic api METHOD PATH [--branch ID]      Call a CMS endpoint
    --json '{"name":"review"}' | --file changes.json | --upload asset.png
  instatic screenshot PAGE_ID --branch ID --out hero.png [--viewport 1280x800]
  instatic forget                             Remove this machine's saved credential

Pass --account ID or set INSTATIC_ACCOUNT for each command. API results are JSON.
Use a branch ID explicitly for site-document writes. Re-read the page after a conflict.`
const endpoint = '/admin/api/cms/'
const credentialSchema = Type.Object({ origin: Type.String(), token: Type.String({ pattern: '^icli_at_[A-Za-z0-9_-]{43}$' }) })
const contextSchema = Type.Object({
  name: Type.String(), account: Type.String(), capabilities: Type.Array(Type.String()),
  operations: Type.Array(Type.Object({ method: Type.String(), path: Type.String(), summary: Type.String() })),
})

function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Value.Check(schema, value)) throw new Error('Unexpected response or invalid local credential')
  return value
}
function siteOrigin(input: string) {
  const url = new URL(input)
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.hash || url.search ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Enter the HTTPS origin of your Instatic site')
  return url.origin
}
async function request(url: URL, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(90000) })
  if (!response.ok) throw new Error(`CMS returned ${response.status}: ${(await response.text()).slice(0, 1800)}`)
  return response
}
function apiUrl(origin: string, path: string) {
  const url = new URL(path.startsWith('/admin/api/') ? path : endpoint + path, origin)
  if (url.origin !== origin || ![endpoint, '/admin/api/ai/'].some(base => url.pathname.startsWith(base)) || url.hash) throw new Error('Expected a CMS-relative path')
  return url
}
async function connect(origin: string, account: string) {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const approval = Promise.withResolvers<string>()
  const listener = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'GET' || url.hostname !== '127.0.0.1' || url.pathname !== '/callback' ||
        url.searchParams.get('state') !== state) return new Response('Invalid callback', { status: 400 })
      if (url.searchParams.get('error') === 'access_denied') {
        approval.reject(new Error('Connection declined'))
        return new Response('Connection declined. You can close this tab.')
      }
      const code = url.searchParams.get('code')
      if (!code?.startsWith('icli_code_')) return new Response('Invalid approval', { status: 400 })
      approval.resolve(code)
      return new Response('Instatic received your approval. Return to your agent.', {
        headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      })
    },
  })
  const timer = setTimeout(() => approval.reject(new Error('Connection timed out. Run connect again.')), 300000)
  try {
    const url = new URL('/admin/ai/cli/authorize', origin)
    url.search = new URLSearchParams({ account, port: String(listener.port), state, challenge }).toString()
    process.stderr.write('Pairing code ' + state.slice(0, 8) + '. Approve this connection in your browser:\n' + url.href + '\n')
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
    if (!values['no-open'] && Bun.which(opener)) {
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href]
      Bun.spawn([opener, ...args], { stdout: 'ignore', stderr: 'ignore' }).unref()
    }
    const code = await approval.promise
    const response = await request(apiUrl(origin, 'service-accounts/' + account + '/exchange'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier }),
    })
    const { token } = checked(Type.Pick(credentialSchema, ['token']), await response.json())
    await Bun.secrets.set({ service: 'Instatic CLI', name: account, value: JSON.stringify({ origin, token }) })
    output('Connected. Run instatic whoami --account ' + account)
  } finally {
    clearTimeout(timer)
    await listener.stop()
  }
}

async function capture(origin: string, token: string, pageId: string) {
  if (!values.branch || !pageId || !values.out) throw new Error('Specify a page ID, --branch ID and --out FILE.png')
  const viewport = /^(\d{2,4})x(\d{2,4})$/.exec(values.viewport ?? '1280x800')
  if (!viewport || Number(viewport[1]) > 4096 || Number(viewport[2]) > 4096) throw new Error('Viewport must be WIDTHxHEIGHT, up to 4096x4096')
  const width = Number(viewport[1]), height = Number(viewport[2])
  const url = apiUrl(origin, 'branches/' + encodeURIComponent(values.branch) + '/review/render')
  url.search = new URLSearchParams({ side: 'branch', row: pageId, width: String(width), height: String(height) }).toString()
  const html = await (await request(url, { headers: { Authorization: 'Bearer ' + token } })).text()
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: process.env.INSTATIC_CHROMIUM || undefined }).catch((err: unknown) => {
    throw new Error('Could not launch Chromium. Set INSTATIC_CHROMIUM to your installed browser executable or install the matching Playwright Chromium with user approval. ' +
      (err instanceof Error ? err.message : String(err)), { cause: err })
  })
  try {
    const page = await browser.newPage({ viewport: { width, height }, javaScriptEnabled: false, serviceWorkers: 'block' })
    const renderUrl = new URL('/_instatic/cli-capture', origin).href
    let skippedResources = 0
    await page.route('**/*', async route => {
      const target = new URL(route.request().url())
      if (route.request().isNavigationRequest()) {
        if (target.href === renderUrl) return route.fulfill({ contentType: 'text/html', body: html })
        return route.abort()
      }
      if (target.origin !== origin || target.pathname.startsWith('/admin/') || target.pathname.startsWith('/_instatic/') ||
        route.request().method() !== 'GET') {
        skippedResources++
        return route.abort()
      }
      // An asset redirect could otherwise leave the installation or expose a local resource.
      const asset = await route.fetch({ maxRedirects: 0, timeout: 10000 }).catch(() => null)
      if (!asset || !asset.ok()) {
        skippedResources++
        return route.abort()
      }
      return route.fulfill({ response: asset })
    })
    await page.goto(renderUrl, { waitUntil: 'networkidle', timeout: 30000 })
    await page.screenshot({ path: values.out, type: 'png', timeout: 30000 })
    output(JSON.stringify({ path: resolve(values.out), branch: values.branch, pageId, width, height, skippedResources }))
  } finally { await browser.close() }
}

async function main() {
  const [command, verb, path] = positionals
  if (values.version) { output('Instatic CLI ' + manifest.version); return }
  if (!command || values.help) { output(help); return }
  const account = values.account ?? process.env.INSTATIC_ACCOUNT
  if (!account || !/^svc_[a-f0-9-]{36}$/.test(account)) throw new Error('Pass the --account ID from the connector prompt')
  if (command === 'connect') return connect(siteOrigin(verb ?? prompt('Instatic site URL') ?? ''), account)
  const key = { service: 'Instatic CLI', name: account }
  if (command === 'forget') { await Bun.secrets.delete(key); return }
  const stored = await Bun.secrets.get(key)
  if (!stored) throw new Error('This account is not connected. Use the connection prompt from Instatic.')
  const { origin: savedOrigin, token } = checked(credentialSchema, JSON.parse(stored))
  const origin = siteOrigin(savedOrigin)
  const headers = new Headers({ Authorization: 'Bearer ' + token })
  if (command === 'api' && verb === 'describe') {
    if (!path || !positionals[3]) throw new Error('Use api describe METHOD PATH from the lookup results')
    const url = apiUrl(origin, 'cli-context')
    url.searchParams.set('describe', path.toUpperCase() + ' ' + positionals[3])
    output(await (await request(url, { headers })).text())
    return
  }
  if (command === 'whoami' || (command === 'api' && verb === 'lookup')) {
    const result = checked(contextSchema, await (await request(apiUrl(origin, 'cli-context'), { headers })).json())
    const words = positionals.slice(2).join(' ').toLowerCase().split(/\s+/).filter(Boolean)
    output(JSON.stringify(command === 'whoami' ? { ...result, origin } : result.operations.filter(op =>
      words.every(word => (op.path + ' ' + op.method + ' ' + op.summary).toLowerCase().includes(word))), null, 2))
    return
  }
  if (command === 'screenshot') return capture(origin, token, verb)
  if (command !== 'api' || !verb || !path || !['GET','POST','PUT','PATCH','DELETE'].includes(verb.toUpperCase())) throw new Error(help)
  const url = apiUrl(origin, path)
  if (url.pathname === endpoint + 'site-document' && !values.branch) throw new Error('Pass --branch explicitly for a draft write')
  if (values.branch) headers.set('X-Instatic-Branch', values.branch)
  if ([values.file, values.json, values.upload].filter(v => v !== undefined).length > 1) throw new Error('Choose one request body')
  let body: string | FormData | undefined
  if (values.upload) {
    body = new FormData()
    body.append('file', Bun.file(values.upload), basename(values.upload))
  } else {
    body = values.file ? await Bun.file(values.file).text() : values.json
    if (body !== undefined) {
      JSON.parse(body)
      headers.set('Content-Type', 'application/json')
    }
  }
  const response = await request(url, { method: verb.toUpperCase(), headers, body })
  output(await response.text())
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
