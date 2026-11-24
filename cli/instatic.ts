#!/usr/bin/env bun
import { openChromium, parseViewport } from './browser'
import { CanvasSnapshotSchema, inspectViewport } from './canvas'
import { saveCredential, readCredential, forgetCredential } from './credentials'
import manifest from './package.json' with { type: 'json' }
import { parseArgs } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2), allowPositionals: true,
  options: {
    node: { type: 'string' }, revision: { type: 'string' }, account: { type: 'string' }, branch: { type: 'string' }, file: { type: 'string' }, upload: { type: 'string' },
    field: { type: 'string', multiple: true }, raw: { type: 'string' },
    json: { type: 'string' }, out: { type: 'string' }, viewport: { type: 'string' },
    live: { type: 'boolean' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
  },
})
function output(text: string) {
  process.stdout.write(text + '\n')
}

const help = `Instatic CLI
  instatic connect SITE --account ID          Authorize this machine in your browser
  instatic check membership [--live] [--out DIRECTORY]    Check published forms and anonymous access; --live exercises a disposable signup
  instatic api lookup "public signup"          Get the membership workflow, live settings and native form operations
  instatic whoami                             Show the current grant
  instatic api lookup [SEARCH]                Search all operations available to this account
  instatic api describe METHOD PATH          Show path, query, request body and CLI usage
  instatic api METHOD PATH [--branch ID]      Call a CMS endpoint
    --json '{"name":"review"}' | --file changes.json | --upload FILE [--field NAME=VALUE] | --raw FILE
    --out FILE saves the response bytes
  instatic canvas modules [MODULE_ID]           List modules or get one module's props schema and defaults
  instatic canvas collection [TABLE_ID_OR_SLUG] --branch ID   Discover collections or get a bound repeating card ready for canvas edit
  instatic visit /PATH --branch ID [--viewport 390x844] [--out visitor.png] [--json STEPS | --file STEPS.json]
    Pass an array, e.g. --json '[{"fillLabel":"Search walks","value":"fossil"},{"expectText":"Fossils"},{"clickLink":"Fossils"},{"expectPath":"/events/fossils"}]'
    Use fill with a CSS selector instead of fillLabel. Use expectHidden to check filtered results.
  instatic canvas read ID_OR_/SLUG [...] --branch ID   Return one editable document and page revisions without a screenshot
  instatic canvas inspect ID_OR_/SLUG --branch ID [--viewport 390x844] [--out before.png] [--node NODE_ID]
    Save a screenshot and return visible nodes, horizontal overflow, assigned CSS rules and a revision.
  instatic canvas edit ID_OR_/SLUG --branch ID --revision REV --json '[{"op":"text","node":"NODE_ID","value":"Title"}]'
    Or --file edits.json. Batch operations: text, inline, rule, insertHtml, memberForm. CSS null removes a declaration.
    Use the revision from canvas read, inspect, or your last save. Inspect at the target viewport to verify.
  instatic screenshot PAGE_ID --branch ID --out hero.png [--viewport 1280x800]
  instatic forget                             Remove this machine's saved credential

Pass --account ID or set INSTATIC_ACCOUNT for each command.
Use a branch ID explicitly for site-document writes. Re-read the page after a conflict.`
const endpoint = '/admin/api/cms/'
const credentialSchema = Type.Object({ origin: Type.String(), token: Type.String({ pattern: '^icli_at_[A-Za-z0-9_-]{43}$' }) })
const contextSchema = Type.Object({
  guide: Type.Optional(Type.Object({ task: Type.String(), steps: Type.Array(Type.Object({ goal: Type.String() })) })),
  name: Type.String(), account: Type.String(), capabilities: Type.Array(Type.String()),
  operations: Type.Array(Type.Object({ method: Type.String(), path: Type.String(), summary: Type.String(), permissions: Type.Optional(Type.Array(Type.Array(Type.String()))) })),
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
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1800)
    throw new Error(`CMS returned ${response.status}: ${detail}`)
  }
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
  const paired = Promise.withResolvers<boolean>()
  function returnToAccount(outcome?: 'declined' | 'failed') {
    const url = new URL('/admin/ai', origin)
    url.searchParams.set('service-account', account)
    if (outcome) url.searchParams.set('pairing', outcome)
    return new Response(null, { status: 303, headers: {
      Location: url.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    } })
  }
  const listener = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req, server) {
      const url = new URL(req.url)
      if (req.method !== 'GET' || url.hostname !== '127.0.0.1' || url.pathname !== '/callback' ||
        url.searchParams.get('state') !== state) return new Response('Invalid callback', { status: 400 })
      if (url.searchParams.get('error') === 'access_denied') {
        approval.reject(new Error('Connection declined'))
        return returnToAccount('declined')
      }
      const code = url.searchParams.get('code')
      if (!code?.startsWith('icli_code_')) return new Response('Invalid approval', { status: 400 })
      server.timeout(req, 0)
      approval.resolve(code)
      // Show the account after the CLI has stored its credential.
      return returnToAccount(await paired.promise ? undefined : 'failed')
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
    await saveCredential(account, JSON.stringify({ origin, token }))
    paired.resolve(true)
    output('Connected. Run instatic whoami --account ' + account)
  } finally {
    paired.resolve(false)
    clearTimeout(timer)
    await listener.stop()
  }
}

async function capture(origin: string, token: string, pageId: string, inspect = false) {
  if (!values.branch || !pageId || (!inspect && !values.out)) throw new Error('Specify a page ID, --branch ID and --out FILE.png')
  const { width, height } = parseViewport(values.viewport)
  const headers = { Authorization: 'Bearer ' + token, 'X-Instatic-Branch': values.branch }
  const target = inspect ? 'canvas/pages/' + encodeURIComponent(pageId) : 'branches/' + encodeURIComponent(values.branch) + '/review/render'
  const url = apiUrl(origin, target)
  url.search = new URLSearchParams({ width: String(width), height: String(height) }).toString()
  if (!inspect) {
    url.searchParams.set('side', 'branch')
    url.searchParams.set('row', pageId)
  }
  const response = await request(url, { headers })
  const snapshot = inspect ? checked(CanvasSnapshotSchema, await response.json()) : undefined
  const html = snapshot ? snapshot.html : await response.text()
  const path = resolve(values.out ?? 'canvas-' + randomBytes(5).toString('hex') + '.png')
  const browser = await openChromium()
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
    await page.screenshot({ path, type: 'png', timeout: 30000 })
    const map = snapshot ? await inspectViewport(page, snapshot, values.node) : {}
    output(JSON.stringify({ path, branch: values.branch, pageId, width, height, skippedResources, ...map }, null, 2))
  } finally { await browser.close() }
}

async function main() {
  const [command, verb, path] = positionals
  if (values.version) { output('Instatic CLI ' + manifest.version); return }
  if (!command || values.help) { output(help); return }
  const account = values.account ?? process.env.INSTATIC_ACCOUNT
  if (!account || !/^svc_[a-f0-9-]{36}$/.test(account)) throw new Error('Pass the --account ID from the connector prompt')
  if (command === 'connect') return connect(siteOrigin(verb ?? prompt('Instatic site URL') ?? ''), account)
  if (command === 'forget') return forgetCredential(account)
  const stored = await readCredential(account)
  if (!stored) throw new Error('This account is not connected. Use the connection prompt from Instatic.')
  const { origin: savedOrigin, token } = checked(credentialSchema, JSON.parse(stored))
  const origin = siteOrigin(savedOrigin)
  const headers = new Headers({ Authorization: 'Bearer ' + token })
  if (command === 'visit') {
    if (!values.branch || !verb || (values.json !== undefined && values.file !== undefined)) throw new Error('Use visit /PATH --branch ID [--json STEPS | --file FILE]')
    headers.set('X-Instatic-Branch', values.branch)
    const { visit } = await import('./visitor')
    const steps: unknown = JSON.parse(values.file ? await Bun.file(values.file).text() : values.json ?? '[]')
    const result = await visit(origin, verb, values, steps, async path => {
      const url = apiUrl(origin, 'canvas/visitor')
      url.searchParams.set('path', path)
      return checked(Type.Object({ html: Type.String() }), await (await request(url, { headers })).json()).html
    })
    output(JSON.stringify(result, null, 2))
    return
  }
  if (command === 'canvas' && (verb === 'modules' || verb === 'collection')) {
    const url = apiUrl(origin, 'canvas/catalog')
    if (values.branch) headers.set('X-Instatic-Branch', values.branch)
    if (verb === 'collection') url.searchParams.set(path ? 'table' : 'collections', path ?? '')
    else if (path) url.searchParams.set('module', path)
    output(await (await request(url, { headers })).text())
    return
  }
  if (command === 'check' && verb === 'membership') {
    const { checkMembership } = await import('./membership')
    const settings = await request(apiUrl(origin, 'members/settings'), { headers })
    output(JSON.stringify(await checkMembership(origin, await settings.json(), !!values.live, values.out), null, 2))
    return
  }
  if (command === 'api' && verb === 'describe') {
    if (!path || !positionals[3]) throw new Error('Use api describe METHOD PATH from the lookup results')
    const url = apiUrl(origin, 'cli-context')
    const pathname = apiUrl(origin, positionals[3]).pathname
    const template = pathname.startsWith(endpoint) ? pathname.slice(endpoint.length) : pathname
    url.searchParams.set('describe', path.toUpperCase() + ' ' + template)
    output(await (await request(url, { headers })).text())
    return
  }
  if (command === 'whoami' || (command === 'api' && verb === 'lookup')) {
    const query = positionals.slice(2).join(' ').toLowerCase()
    const words = query.split(/\s+/).filter(Boolean)
    const url = apiUrl(origin, 'cli-context')
    if (verb === 'lookup' && !query.includes('/') && /\b(membership|members?|signup|sign[ -]?up|registration|login|sign[ -]?in)\b/.test(query)) {
      url.searchParams.set('guide', 'membership')
    }
    const { operations, guide, ...identity } = checked(contextSchema, await (await request(url, { headers })).json())
    if (command === 'whoami') { output(JSON.stringify({ ...identity, origin }, null, 2)); return }
    const matches = operations.filter(op => {
      const pathname = op.path.startsWith('/') ? op.path : endpoint + op.path
      const searchable = [op.method, pathname, op.summary, ...(op.permissions ?? []).flat()].join(' ').toLowerCase()
      return words.every(word => searchable.includes(word))
    })
    const listingQuery = /\b(list|directories|directory|listings?|collections?|loops?|repeat(?:ing|er)?)\b/.test(query)
    if (!guide && query && !query.includes('/') && (listingQuery || !matches.length) &&
        operations.some(operation => operation.path === 'canvas/catalog')) {
      const catalog = apiUrl(origin, 'canvas/catalog')
      catalog.searchParams.set('search', query)
      if (values.branch) headers.set('X-Instatic-Branch', values.branch)
      const collection: unknown = await (await request(catalog, { headers })).json()
      const foundTable = Value.Check(Type.Object({ table: Type.Object({ id: Type.String() }) }), collection)
      output(JSON.stringify(listingQuery || foundTable ? { collection, operations: matches } : matches, null, 2))
    } else output(JSON.stringify(guide ? { guide, operations: matches } : matches, null, 2))
    return
  }
  if (command === 'canvas' && verb === 'read') {
    if (!values.branch || !path) throw new Error('Specify page IDs or /slugs and --branch ID')
    const url = apiUrl(origin, 'canvas/pages')
    for (const ref of positionals.slice(2)) url.searchParams.append('ref', ref)
    headers.set('X-Instatic-Branch', values.branch)
    output(await (await request(url, { headers })).text())
    return
  }
  if (command === 'canvas' && verb === 'inspect') return capture(origin, token, path, true)
  if (command === 'canvas' && verb === 'edit') {
    if (!path || !values.branch || !values.revision || Number(values.file !== undefined) + Number(values.json !== undefined) !== 1) {
      throw new Error('Use canvas edit ID_OR_/SLUG --branch ID --revision REV and either --json EDIT_ARRAY or --file EDITS.json')
    }
    headers.set('X-Instatic-Branch', values.branch)
    headers.set('Content-Type', 'application/json')
    const edits: unknown = JSON.parse(values.file ? await Bun.file(values.file).text() : values.json!)
    const response = await request(apiUrl(origin, 'canvas/pages/' + encodeURIComponent(path)), {
      method: 'PATCH', headers, body: JSON.stringify({ revision: values.revision, edits }),
    })
    output(await response.text())
    return
  }
  if (command === 'screenshot') return capture(origin, token, verb)
  if (command !== 'api' || !verb || !path || !['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(verb.toUpperCase())) throw new Error(help)
  const url = apiUrl(origin, path)
  if (url.pathname === endpoint + 'site-document' && !values.branch) throw new Error('Pass --branch explicitly for a draft write')
  if (values.branch) headers.set('X-Instatic-Branch', values.branch)
  if ([values.file, values.json, values.upload, values.raw].filter(v => v !== undefined).length > 1) throw new Error('Choose one request body')
  if (values.field && !values.upload) throw new Error('Use --field with --upload')
  let body: string | FormData | Blob | undefined
  if (values.upload) {
    body = new FormData()
    body.append('file', Bun.file(values.upload), basename(values.upload))
    for (const field of values.field ?? []) {
      const split = field.indexOf('=')
      if (split <= 0) throw new Error('Use --field NAME=VALUE')
      body.append(field.slice(0, split), field.slice(split + 1))
    }
  } else if (values.raw) {
    body = Bun.file(values.raw)
  } else {
    body = values.file ? await Bun.file(values.file).text() : values.json
    if (body !== undefined) {
      JSON.parse(body)
      headers.set('Content-Type', 'application/json')
    }
  }
  const response = await request(url, { method: verb.toUpperCase(), headers, body })
  if (verb.toUpperCase() === 'HEAD') output(JSON.stringify(Object.fromEntries(response.headers), null, 2))
  else if (values.out) await Bun.write(values.out, response)
  else if (response.headers.get('content-type')?.startsWith('text/event-stream')) await Bun.write(Bun.stdout, response)
  else output(await response.text())
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 })
