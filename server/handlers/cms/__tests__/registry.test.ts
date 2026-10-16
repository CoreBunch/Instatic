import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../../../../src/__tests__/helpers/capabilityHarness'
import { setRegistryFetchForTests } from '../../../registry/client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const SEARCH_BODY = {
  total: 1,
  objects: [{
    package: { name: 'three', version: '0.185.1', description: '3D', keywords: [], date: '2026-07-01T00:00:00Z', links: {}, publisher: { username: 'mrdoob' } },
    downloads: { weekly: 10 },
    dependents: 2,
    score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
    flags: {},
  }],
}

const PACKUMENT = {
  name: '@scope/pkg',
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': { dist: { unpackedSize: 10, fileCount: 1 }, module: 'index.mjs' } },
  time: { '1.0.0': '2026-01-01T00:00:00Z' },
  readme: 'hello',
}

describe('registry proxy routes', () => {
  let harness: CapabilityTestHarness
  let cookie: string
  const seen: string[] = []

  beforeEach(async () => {
    harness = await createCapabilityTestHarness()
    cookie = await harness.setupOwner()
    seen.length = 0
    // Routed on the parsed host and path, never a substring: a bare
    // `includes('api.npmjs.org')` matches any URL that merely contains the
    // host, which is the shape CodeQL flags wherever it appears.
    setRegistryFetchForTests((async (input: RequestInfo | URL) => {
      const raw = String(input)
      seen.push(raw)
      const url = new URL(raw)
      if (url.host === 'api.npmjs.org') return json({ downloads: [{ day: 'x', downloads: 5 }] })
      if (url.host === 'api.osv.dev') return json({ vulns: [] })
      if (url.pathname === '/-/v1/search') return json(SEARCH_BODY)
      if (url.pathname === '/@scope%2Fpkg/latest') return json({ name: '@scope/pkg', version: '1.0.0' })
      if (url.pathname === '/@scope%2Fpkg') return json(PACKUMENT)
      if (url.pathname === '/flaky') return json({ error: 'upstream down' }, 502)
      return json({ error: 'not found' }, 404)
    }) as typeof fetch)
  })

  afterEach(async () => {
    setRegistryFetchForTests(null)
    await harness.cleanup()
  })

  it('requires an authenticated session', async () => {
    const res = await harness.cms('/admin/api/cms/registry/search?q=three')
    expect(res.status).toBe(401)
    expect(seen).toHaveLength(0)
  })

  it('describes the configured registry without exposing more than its host', async () => {
    expect((await harness.cms('/admin/api/cms/registry')).status).toBe(401)
    const res = await harness.cms('/admin/api/cms/registry', { cookie })
    expect(res.status).toBe(200)
    expect(await readJson<{ host: string; publicNpm: boolean }>(res)).toEqual({ host: 'registry.npmjs.org', publicNpm: true })
  })

  it('searches through the configured registry and validates the query', async () => {
    const res = await harness.cms('/admin/api/cms/registry/search?q=three&sort=popularity&size=5', { cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('private')
    const page = await readJson<{ total: number; returned: number; hits: Array<{ name: string }> }>(res)
    expect(page.total).toBe(1)
    expect(page.returned).toBe(1)
    expect(page.hits[0].name).toBe('three')
    expect(seen[0]).toContain('/-/v1/search?text=three+not%3Adeprecated')

    expect((await harness.cms('/admin/api/cms/registry/search?q=', { cookie })).status).toBe(400)
    expect((await harness.cms('/admin/api/cms/registry/search?q=x&size=500', { cookie })).status).toBe(400)
    expect((await harness.cms('/admin/api/cms/registry/search?q=x&sort=weird', { cookie })).status).toBe(400)
  })

  it('serves scoped package details, latest, downloads and advisories', async () => {
    const name = encodeURIComponent('@scope/pkg')
    const details = await harness.cms(`/admin/api/cms/registry/packages/${name}`, { cookie })
    expect(details.status).toBe(200)
    const body = await readJson<{ name: string; latest: string; versions: Array<{ esmEntry: unknown }> }>(details)
    expect(body.name).toBe('@scope/pkg')
    expect(body.latest).toBe('1.0.0')
    expect(body.versions[0].esmEntry).toEqual({ path: 'index.mjs', source: 'module' })

    const latest = await readJson<{ version: string | null }>(await harness.cms(`/admin/api/cms/registry/packages/${name}/latest`, { cookie }))
    expect(latest.version).toBe('1.0.0')

    const downloads = await readJson<{ daily: number[]; weekly: number }>(await harness.cms(`/admin/api/cms/registry/packages/${name}/downloads`, { cookie }))
    expect(downloads).toEqual({ daily: [5], weekly: 5 })

    const advisories = await harness.cms(`/admin/api/cms/registry/packages/${name}/advisories?version=1.0.0`, { cookie })
    expect(await readJson<{ advisories: unknown[] }>(advisories)).toEqual({ advisories: [] })
    expect((await harness.cms(`/admin/api/cms/registry/packages/${name}/advisories`, { cookie })).status).toBe(400)
  })

  it('rejects unsafe names and maps upstream failures', async () => {
    expect((await harness.cms('/admin/api/cms/registry/packages/..%2Fetc', { cookie })).status).toBe(400)
    expect((await harness.cms('/admin/api/cms/registry/packages/UPPER', { cookie })).status).toBe(400)
    expect((await harness.cms('/admin/api/cms/registry/packages/missing-one', { cookie })).status).toBe(404)
    const flaky = await harness.cms('/admin/api/cms/registry/packages/flaky', { cookie })
    expect(flaky.status).toBe(502)
    expect((await readJson<{ error: string }>(flaky)).error).toContain('502')
  })

  it('answers wrong methods with 405', async () => {
    const res = await harness.cms('/admin/api/cms/registry/search?q=x', { cookie, method: 'POST', json: {} })
    expect(res.status).toBe(405)
  })
})
