import { afterEach, describe, expect, it } from 'bun:test'
import {
  RegistryUpstreamError,
  getAdvisories,
  getDownloads,
  getLatestVersion,
  getPackageDetails,
  getInstallPackument,
  packageDetailsFromPackument,
  searchPackages,
  setRegistryFetchForTests,
} from '../client'
import {
  DEFAULT_NPM_REGISTRY_URL,
  configureNpmRegistryUrl,
  isPublicNpmRegistry,
  parseNpmRegistryUrl,
  registryProfile,
} from '../config'

afterEach(() => {
  setRegistryFetchForTests(null)
  configureNpmRegistryUrl(DEFAULT_NPM_REGISTRY_URL)
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recordingFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return respond(url, init)
  }) as typeof fetch
  return { fetchImpl, calls }
}

function acceptHeader(init?: RequestInit): string {
  const headers = init?.headers
  return headers && !Array.isArray(headers) && !(headers instanceof Headers) ? (headers.accept ?? '') : ''
}

const SEARCH_BODY = {
  total: 42,
  objects: [
    {
      package: {
        name: 'three',
        version: '0.185.1',
        description: 'JavaScript **3D** library',
        date: '2026-07-01T14:04:30.373Z',
        publisher: { username: 'mrdoob' },
      },
      downloads: { weekly: 15193062 },
      dependents: '5567',
      score: { detail: { quality: 1, popularity: 0.9, maintenance: 0.8 } },
      flags: { insecure: 0 },
    },
    { package: { name: 'JSONStream', version: '1.3.5' } },
    { package: { version: 'no-name' } },
  ],
}

const SEARCH_PARAMS = { text: 'three', sort: 'relevance', from: 0, size: 20, hideDeprecated: false } as const

describe('searchPackages', () => {
  it('builds the public registry search URL with the deprecated qualifier and sort weights', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json(SEARCH_BODY))
    const page = await searchPackages({ text: 'three', sort: 'popularity', from: 20, size: 10, hideDeprecated: true }, { fetchImpl })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('https://registry.npmjs.org/-/v1/search')
    expect(url.searchParams.get('text')).toBe('three not:deprecated')
    expect(url.searchParams.get('size')).toBe('10')
    expect(url.searchParams.get('from')).toBe('20')
    expect(url.searchParams.get('popularity')).toBe('1')
    expect(url.searchParams.get('quality')).toBe('0')
    expect(url.searchParams.get('maintenance')).toBe('0')
    expect(page.total).toBe(42)
    expect(page.hits[0]).toEqual({
      name: 'three',
      version: '0.185.1',
      description: 'JavaScript 3D library',
      publisher: 'mrdoob',
      date: '2026-07-01T14:04:30.373Z',
      weeklyDownloads: 15193062,
      dependents: 5567,
      score: { quality: 1, popularity: 0.9, maintenance: 0.8 },
      insecure: false,
    })
  })

  it('sends a private registry the literal text only: npm qualifiers would match nothing there', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json(SEARCH_BODY))
    await searchPackages(
      { text: 'three', sort: 'relevance', from: 0, size: 20, hideDeprecated: true },
      { fetchImpl, registryUrl: 'https://registry.example/' },
    )
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('https://registry.example/-/v1/search')
    expect(url.searchParams.get('text')).toBe('three')
  })

  it('drops hits the site runtime could never install (unsafe names) and nameless entries', async () => {
    const { fetchImpl } = recordingFetch(() => json(SEARCH_BODY))
    const page = await searchPackages(SEARCH_PARAMS, { fetchImpl })
    expect(page.hits.map((hit) => hit.name)).toEqual(['three'])
  })

  it('treats a registry without a search endpoint as an empty result, not an error', async () => {
    const { fetchImpl } = recordingFetch(() => json({ error: 'not found' }, 404))
    expect(await searchPackages(SEARCH_PARAMS, { fetchImpl, registryUrl: 'https://registry.example' }))
      .toEqual({ total: 0, returned: 0, hits: [] })
  })

  it('reports how many entries the registry returned, so the caller can tell the list is exhausted', async () => {
    const { fetchImpl } = recordingFetch(() => json(SEARCH_BODY))
    const page = await searchPackages(SEARCH_PARAMS, { fetchImpl })
    // Three objects upstream, one installable hit, and a `total` that counts neither.
    expect(page.returned).toBe(3)
    expect(page.hits).toHaveLength(1)
    expect(page.total).toBe(42)
  })

  it('aborts an uncached read when the caller abandons the request', async () => {
    const controller = new AbortController()
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    const pending = searchPackages(SEARCH_PARAMS, { fetchImpl, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'RegistryUpstreamError' })
  })

  it('does not let an abandoning caller fail the others sharing a cached load', async () => {
    let release: (value: Response) => void = () => {}
    setRegistryFetchForTests((() => new Promise<Response>((resolve) => { release = resolve })) as typeof fetch)
    const abandoned = new AbortController()
    const first = searchPackages(SEARCH_PARAMS, { signal: abandoned.signal })
    const second = searchPackages(SEARCH_PARAMS, { signal: new AbortController().signal })
    abandoned.abort()
    release(json(SEARCH_BODY))
    // Both joined one in-flight load; the caller that walked away must not
    // take the answer away from the one still waiting.
    expect((await second).hits.map((hit) => hit.name)).toEqual(['three'])
    expect((await first).total).toBe(42)
  })

  it('refuses a body past the size cap even when no content-length declares it', async () => {
    const oversized = new Uint8Array(1024 * 1024)
    const fetchImpl = (() => {
      let sent = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += oversized.byteLength
          if (sent > 64 * 1024 * 1024) return controller.close()
          controller.enqueue(oversized)
        },
      })
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
    await expect(getPackageDetails('huge-pkg', { fetchImpl })).rejects.toMatchObject({ kind: 'too-large' })
  })

  it('omits sort weights for relevance and serves repeats from the cache', async () => {
    let calls = 0
    setRegistryFetchForTests((async (input: RequestInfo | URL) => {
      calls++
      expect(new URL(String(input)).searchParams.has('popularity')).toBe(false)
      return json(SEARCH_BODY)
    }) as typeof fetch)
    await searchPackages(SEARCH_PARAMS)
    await searchPackages(SEARCH_PARAMS)
    expect(calls).toBe(1)
  })

  it('maps upstream failures to RegistryUpstreamError', async () => {
    const { fetchImpl } = recordingFetch(() => json({ error: 'nope' }, 503))
    await expect(searchPackages(SEARCH_PARAMS, { fetchImpl })).rejects.toMatchObject({
      name: 'RegistryUpstreamError',
      kind: 'status',
      status: 503,
    })

    const { fetchImpl: broken } = recordingFetch(() => new Response('<html>', { status: 200 }))
    await expect(searchPackages(SEARCH_PARAMS, { fetchImpl: broken })).rejects.toMatchObject({ kind: 'shape' })
  })

  it('reports a timeout when the upstream never answers', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as typeof fetch
    await expect(searchPackages(SEARCH_PARAMS, { fetchImpl, timeoutMs: 5 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('reports a timeout when the body stalls after the headers arrived', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"total":1,"objects":['))
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      })
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
    await expect(searchPackages(SEARCH_PARAMS, { fetchImpl, timeoutMs: 20 })).rejects.toMatchObject({ kind: 'timeout' })
  })
})

const PACKUMENT = {
  name: 'dayjs',
  description: 'Date library',
  'dist-tags': { latest: '1.11.23', alpha: '2.0.0-alpha.4' },
  versions: {
    '1.11.22': { dist: { unpackedSize: 100, fileCount: 2 }, main: 'dayjs.min.js', license: 'MIT' },
    '1.11.23': { dist: { unpackedSize: 120, fileCount: 3 }, main: 'dayjs.min.js', types: 'index.d.ts', license: 'MIT', dependencies: { a: '^1', bad: 7 }, peerDependencies: { b: '>=2' } },
    '2.0.0-alpha.4': { dist: {}, exports: { '.': { import: './esm/index.js' } }, deprecated: 'use 1.x', license: { type: 'ISC' } },
  },
  time: { created: '2018-01-01T00:00:00Z', modified: '2026-08-17T00:00:00Z', '1.11.22': '2026-01-01T00:00:00Z', '1.11.23': '2026-08-17T00:00:00Z', '2.0.0-alpha.4': '2025-01-01T00:00:00Z' },
  readme: '# Day.js',
  homepage: 'https://day.js.org',
  repository: { type: 'git', url: 'git+https://github.com/iamkun/dayjs.git' },
  maintainers: [{ name: 'iamkun' }, { name: 3 }],
  keywords: ['date', 'time', 9],
}

describe('package details', () => {
  it('maps a packument to details with newest-first versions and ESM preflight', () => {
    const details = packageDetailsFromPackument('dayjs', PACKUMENT)
    expect(details.latest).toBe('1.11.23')
    expect(details.versionCount).toBe(3)
    expect(details.versions.map((v) => v.version)).toEqual(['1.11.23', '1.11.22', '2.0.0-alpha.4'])
    expect(details.versions[0]).toMatchObject({
      hasTypes: true,
      esmEntry: { path: 'dayjs.min.js', source: 'main' },
      dependencies: { a: '^1' },
      peerDependencies: { b: '>=2' },
      unpackedSize: 120,
      fileCount: 3,
      license: 'MIT',
    })
    expect(details.versions[2]).toMatchObject({ deprecated: 'use 1.x', license: 'ISC', esmEntry: { path: './esm/index.js', source: 'exports' } })
    expect(details.repository).toBe('https://github.com/iamkun/dayjs')
    expect(details.license).toBe('MIT')
    expect(details.maintainers).toEqual(['iamkun'])
    expect(details.keywords).toEqual(['date', 'time'])
    expect(details.modified).toBe('2026-08-17T00:00:00Z')
  })

  it('always keeps dist-tagged versions even when newer prereleases crowd them out', () => {
    const versions: Record<string, { dist: Record<string, never> }> = {}
    const time: Record<string, string> = {}
    versions['19.0.0'] = { dist: {} }
    time['19.0.0'] = '2025-01-01T00:00:00Z'
    for (let i = 0; i < 150; i++) {
      const version = `19.1.0-canary.${i}`
      versions[version] = { dist: {} }
      time[version] = `2026-01-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00Z`
    }
    const details = packageDetailsFromPackument('react', { name: 'react', 'dist-tags': { latest: '19.0.0' }, versions, time })
    expect(details.versionCount).toBe(151)
    expect(details.versions).toHaveLength(101)
    expect(details.versions.some((info) => info.version === '19.0.0')).toBe(true)
  })

  it('tolerates odd decorative metadata: it is filtered, never a reason to reject the packument', async () => {
    const { fetchImpl } = recordingFetch(() => json({
      ...PACKUMENT,
      description: ['not', 'a', 'string'],
      readme: 42,
      keywords: 'date, time',
      maintainers: { name: 'iamkun' },
    }))
    const details = await getPackageDetails('dayjs', { fetchImpl })
    expect(details.latest).toBe('1.11.23')
    expect(details.description).toBe('')
    expect(details.readme).toBe('')
    expect(details.keywords).toEqual([])
    expect(details.maintainers).toEqual([])
  })

  it('fetches scoped packages with an encoded slash and asks for the full packument by default', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ ...PACKUMENT, name: '@scope/pkg' }))
    const details = await getPackageDetails('@scope/pkg', { fetchImpl, registryUrl: 'https://registry.example' })
    expect(calls[0].url).toBe('https://registry.example/@scope%2Fpkg')
    expect(acceptHeader(calls[0].init)).toBe('application/json')
    expect(details.name).toBe('@scope/pkg')
  })

  it('asks for the abbreviated install document on the resolver path', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json(PACKUMENT))
    await getInstallPackument('dayjs', { fetchImpl })
    expect(acceptHeader(calls[0].init)).toContain('application/vnd.npm.install-v1+json')
  })

  it('drops dist-tags that point at versions the packument no longer carries', () => {
    const details = packageDetailsFromPackument('dayjs', {
      ...PACKUMENT,
      'dist-tags': { latest: '1.11.23', gone: '9.9.9' },
    })
    expect(details.distTags).toEqual({ latest: '1.11.23' })
  })

  it('truncates a runaway README rather than caching megabytes of prose', () => {
    const details = packageDetailsFromPackument('big', { ...PACKUMENT, readme: 'x'.repeat(400_000) })
    expect(details.readme.length).toBe(256 * 1024)
  })

  it('serves details from the cache, seeds latest from them, and always fetches a fresh packument for the resolver', async () => {
    let calls = 0
    setRegistryFetchForTests((async () => {
      calls++
      return json(PACKUMENT)
    }) as typeof fetch)
    await getPackageDetails('dayjs')
    await getPackageDetails('dayjs')
    expect(await getLatestVersion('dayjs')).toEqual({ version: '1.11.23' })
    expect(calls).toBe(1)
    await getInstallPackument('dayjs')
    await getInstallPackument('dayjs')
    expect(calls).toBe(3)
  })

  it('never seeds a shared cache from an injected transport', async () => {
    const { fetchImpl } = recordingFetch(() => json(PACKUMENT))
    await getPackageDetails('dayjs', { fetchImpl })
    // The injected run must leave no trace: an uninjected read goes upstream.
    const { fetchImpl: second, calls } = recordingFetch(() => json({ name: 'dayjs', version: '2.0.0' }))
    expect(await getLatestVersion('dayjs', { fetchImpl: second })).toEqual({ version: '2.0.0' })
    expect(calls).toHaveLength(1)
  })

  it('reads the latest version from the small dist-tag manifest when nothing is cached', async () => {
    const { fetchImpl, calls } = recordingFetch((url) => (url.endsWith('/latest') ? json({ name: 'dayjs', version: '1.11.23' }) : json(PACKUMENT)))
    expect(await getLatestVersion('dayjs', { fetchImpl })).toEqual({ version: '1.11.23' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://registry.npmjs.org/dayjs/latest')
  })

  it('rejects unsafe package names before any request', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json(PACKUMENT))
    await expect(getPackageDetails('../etc', { fetchImpl })).rejects.toThrow('Invalid package name')
    expect(calls).toHaveLength(0)
  })

  it('turns a 404 packument into a 404 upstream error and an unknown latest', async () => {
    const { fetchImpl } = recordingFetch(() => json({ error: 'Not found' }, 404))
    await expect(getPackageDetails('missing-pkg', { fetchImpl })).rejects.toBeInstanceOf(RegistryUpstreamError)
    await expect(getPackageDetails('missing-pkg', { fetchImpl })).rejects.toMatchObject({ status: 404 })
    expect(await getLatestVersion('missing-pkg', { fetchImpl })).toEqual({ version: null })
  })
})

describe('downloads / advisories', () => {
  it('sums the trailing week of daily downloads and reports unknown packages as no data', async () => {
    const daily = Array.from({ length: 30 }, (_, i) => ({ day: `d${i}`, downloads: i + 1 }))
    const { fetchImpl, calls } = recordingFetch((url) => (url.includes('/unknown') ? json({}, 404) : json({ downloads: daily })))
    const stats = await getDownloads('three', { fetchImpl })
    expect(calls[0].url).toBe('https://api.npmjs.org/downloads/range/last-month/three')
    expect(stats.daily).toHaveLength(30)
    expect(stats.weekly).toBe(24 + 25 + 26 + 27 + 28 + 29 + 30)
    expect(await getDownloads('unknown', { fetchImpl })).toEqual({ daily: [], weekly: null })
  })

  it('queries OSV by name and version and maps advisories', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({
      vulns: [
        { id: 'GHSA-1', summary: 'Prototype pollution', aliases: ['CVE-2020-1'], database_specific: { severity: 'HIGH' } },
        { summary: 'no id' },
      ],
    }))
    const result = await getAdvisories('lodash', '4.17.20', { fetchImpl })
    expect(calls[0].url).toBe('https://api.osv.dev/v1/query')
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ package: { name: 'lodash', ecosystem: 'npm' }, version: '4.17.20' })
    expect(result.advisories).toEqual([{ id: 'GHSA-1', summary: 'Prototype pollution', severity: 'high' }])
    await expect(getAdvisories('lodash', 'not a version!', { fetchImpl })).rejects.toThrow('Invalid version')
  })

  it('never sends private-registry package names to the public stats APIs', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({}))
    const deps = { fetchImpl, registryUrl: 'https://npm.internal.example' }
    expect(await getDownloads('secret-pkg', deps)).toEqual({ daily: [], weekly: null })
    expect(await getAdvisories('secret-pkg', '1.0.0', deps)).toEqual({ advisories: [] })
    expect(calls).toHaveLength(0)
  })
})

describe('registry config', () => {
  it('parses NPM_REGISTRY_URL: defaults, normalises, and ignores invalid values', () => {
    expect(parseNpmRegistryUrl(undefined)).toBe('https://registry.npmjs.org')
    expect(parseNpmRegistryUrl('https://mirror.example/npm/')).toBe('https://mirror.example/npm')
    expect(parseNpmRegistryUrl('ftp://nope')).toBe('https://registry.npmjs.org')
    expect(parseNpmRegistryUrl('not a url')).toBe('https://registry.npmjs.org')
  })

  it('only the public registry counts as public, and the profile never carries credentials', () => {
    expect(isPublicNpmRegistry('https://registry.npmjs.org/')).toBe(true)
    expect(isPublicNpmRegistry('https://registry.yarnpkg.com')).toBe(false)
    expect(registryProfile()).toEqual({ host: 'registry.npmjs.org', publicNpm: true })

    configureNpmRegistryUrl(parseNpmRegistryUrl('https://user:secret@npm.internal.example/registry/'))
    expect(registryProfile()).toEqual({ host: 'npm.internal.example', publicNpm: false })
  })
})
