/**
 * Tests for the `/_instatic/hole/<nodeId>` and `/_instatic/hole-runtime.js` endpoints.
 *
 * Uses a minimal fake DbClient that intercepts `getLatestPublishedSiteSnapshot`
 * queries (the same pattern as publicRouterCache.test.ts).
 *
 * Covers:
 *   - Correct version (matches current publishVersion) → 200 + HTML fragment
 *   - Stale version (?v= mismatch) → stale sentinel without caching
 *   - Missing node → 404
 *   - Site not published → 404
 *   - Non-GET method → 405
 *   - Runtime asset endpoint serves HOLE_RUNTIME_JS with correct headers
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/db'
import {
  handleHoleRequest,
  isHoleRuntimeAssetPath,
  serveHoleRuntimeAsset,
} from '../../../server/handlers/cms/hole'
import { resetForTests } from '../../../server/publish/renderCache'
import { bumpPublishVersion, getPublishVersion } from '../../../server/publish/publishState'
import { HOLE_RUNTIME_JS } from '../../../server/publish/holeRuntime'
import { makeModule } from '../publisher/helpers'
import { registry } from '../../core/module-engine/registry'

// ---------------------------------------------------------------------------
// Snapshot fixture
// ---------------------------------------------------------------------------

function makeSnapshot() {
  return {
    cmsSnapshotVersion: 1 as const,
    pageRowId: 'page_1',
    site: {
      id: 'site_1',
      name: 'Test Site',
      pages: [
        {
          id: 'page_1',
          title: 'Test Page',
          slug: 'test',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'test.body',
              props: {},
              breakpointOverrides: {},
              children: ['text-node'],
              classIds: [],
            },
            'text-node': {
              id: 'text-node',
              moduleId: 'test.text',
              props: { text: 'Hello from hole' },
              breakpointOverrides: {},
              children: [],
              classIds: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
      settings: { metaTitle: 'Test', shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
      packageJson: { dependencies: {}, devDependencies: {} },
      runtime: {
        dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
        scripts: {},
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

function makeFakeDb(snapshot: ReturnType<typeof makeSnapshot> | null): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('site_snapshots.site_json')) {
      return {
        rows: snapshot
          ? [{
              row_id: snapshot.pageRowId,
              site_json: snapshot.site,
              runtime_assets_json: null,
              importmap_body: null,
              importmap_sha256: null,
            } as unknown as Row]
          : [],
        rowCount: snapshot ? 1 : 0,
      }
    }

    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

/**
 * Fake DB that counts snapshot loads and yields a microtask before resolving,
 * so concurrent hole requests overlap and exercise the version-keyed
 * single-flight in `publishState`. `count()` reports how many times the
 * published-snapshot query actually hit the DB.
 */
function makeCountingDb(snapshot: ReturnType<typeof makeSnapshot>): {
  db: DbClient
  count: () => number
} {
  let loads = 0
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('site_snapshots.site_json')) {
      loads++
      await Promise.resolve() // let other in-flight callers join before resolving
      return {
        rows: [{
          row_id: snapshot.pageRowId,
          site_json: snapshot.site,
          runtime_assets_json: null,
          importmap_body: null,
          importmap_sha256: null,
        } as unknown as Row],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  }
  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)
  return { db: handle as DbClient, count: () => loads }
}

// ---------------------------------------------------------------------------
// Setup — register minimal test modules in the singleton registry
// (the hole handler uses the singleton registry to look up module renderers)
// ---------------------------------------------------------------------------

beforeEach(() => {
  // `resetForTests` clears the LRU and delegates to `resetPublishStateForTests`,
  // which resets the publish version AND every version-keyed single-flight memo
  // — including the hole endpoint's snapshot cache. No bespoke hole reset hook.
  resetForTests()

  // Register test-specific module IDs using registerOrReplace so these tests
  // never conflict with base module registrations in other test files.
  registry.registerOrReplace(
    makeModule('test.body', {
      render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
    }),
  )
  registry.registerOrReplace(
    makeModule('test.text', {
      render: (p) => ({ html: `<span>${String(p['text'] ?? '')}</span>` }),
    }),
  )
})

// ---------------------------------------------------------------------------
// isHoleRuntimeAssetPath
// ---------------------------------------------------------------------------

describe('isHoleRuntimeAssetPath', () => {
  it('returns true for /_instatic/hole-runtime.js', () => {
    expect(isHoleRuntimeAssetPath('/_instatic/hole-runtime.js')).toBe(true)
  })

  it('returns false for other paths', () => {
    expect(isHoleRuntimeAssetPath('/_instatic/hole/')).toBe(false)
    expect(isHoleRuntimeAssetPath('/_instatic/hole-runtime')).toBe(false)
    expect(isHoleRuntimeAssetPath('/_instatic/assets/loop-runtime.js')).toBe(false)
    expect(isHoleRuntimeAssetPath('/_instatic/hole/some-node-id')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serveHoleRuntimeAsset
// ---------------------------------------------------------------------------

describe('serveHoleRuntimeAsset', () => {
  it('serves the HOLE_RUNTIME_JS source with correct headers', () => {
    const res = serveHoleRuntimeAsset()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  it('response body matches HOLE_RUNTIME_JS export', async () => {
    const res = serveHoleRuntimeAsset()
    const body = await res.text()
    expect(body).toBe(HOLE_RUNTIME_JS)
  })
})

// ---------------------------------------------------------------------------
// handleHoleRequest — method guard
// ---------------------------------------------------------------------------

describe('handleHoleRequest — method guard', () => {
  it('returns 405 for non-GET methods', async () => {
    const db = makeFakeDb(null)

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const url = new URL('http://localhost/_instatic/hole/text-node?v=0')
      const req = new Request(url, { method })
      const res = await handleHoleRequest(req, url, { db })
      expect(res.status).toBe(405)
    }
  })
})

// ---------------------------------------------------------------------------
// handleHoleRequest — site not published
// ---------------------------------------------------------------------------

describe('handleHoleRequest — site not published', () => {
  it('returns 404 when no published snapshot exists', async () => {
    const db = makeFakeDb(null)
    const currentVersion = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=${currentVersion}`)
    const req = new Request(url)
    const res = await handleHoleRequest(req, url, { db })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// handleHoleRequest — stale version
// ---------------------------------------------------------------------------

describe('handleHoleRequest — stale version', () => {
  it('returns stale sentinel when ?v= does not match current publishVersion', async () => {
    const snapshot = makeSnapshot()
    const db = makeFakeDb(snapshot)

    // Bump the publish version so v=0 becomes stale
    bumpPublishVersion()
    const currentVersion = getPublishVersion() // = 1

    // Request with the old version (0, now stale)
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=0`)
    const req = new Request(url)
    const res = await handleHoleRequest(req, url, { db })

    const body = await res.text()
    expect(body).toContain('instatic-hole-stale')
    expect(body).toContain('data-instatic-stale="true"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Stale responses must NOT be 404 or 500 — the browser replaces the
    // placeholder with the stale sentinel and the user can still see content
    expect(res.status).toBe(200)

    // Suppress unused variable warning
    void currentVersion
  })

  it('returns stale sentinel even when a snapshot exists — version mismatch wins', async () => {
    const snapshot = makeSnapshot()
    const db = makeFakeDb(snapshot)

    bumpPublishVersion()

    // Old version
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=0`)
    const req = new Request(url)
    const res = await handleHoleRequest(req, url, { db })

    expect((await res.text())).toContain('instatic-hole-stale')
  })
})

// ---------------------------------------------------------------------------
// handleHoleRequest — node not found
// ---------------------------------------------------------------------------

describe('handleHoleRequest — node not found', () => {
  it('returns 404 when nodeId is not present in any page', async () => {
    const snapshot = makeSnapshot()
    const db = makeFakeDb(snapshot)

    const currentVersion = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/no-such-node?v=${currentVersion}`)
    const req = new Request(url)
    const res = await handleHoleRequest(req, url, { db })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// handleHoleRequest — successful render
// ---------------------------------------------------------------------------

describe('handleHoleRequest — successful render', () => {
  it('returns 200 with rendered HTML fragment for a matching node + version', async () => {
    const snapshot = makeSnapshot()
    const db = makeFakeDb(snapshot)

    const currentVersion = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=${currentVersion}`)
    const req = new Request(url)
    const res = await handleHoleRequest(req, url, { db })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')

    const body = await res.text()
    // The test.text module renders a <span> with the text prop
    expect(body).toContain('Hello from hole')
  })

  it('second request for the same node+version hits the Layer B cache (same body)', async () => {
    const snapshot = makeSnapshot()
    const db = makeFakeDb(snapshot)

    const currentVersion = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=${currentVersion}`)

    const res1 = await handleHoleRequest(new Request(url), url, { db })
    const body1 = await res1.text()

    const res2 = await handleHoleRequest(new Request(url), url, { db })
    const body2 = await res2.text()

    expect(body1).toBe(body2)
    expect(res2.status).toBe(200)
  })

  it('becomes stale for old ?v= after bumpPublishVersion()', async () => {
    const snapshot = makeSnapshot()
    const db = makeFakeDb(snapshot)

    const oldVersion = getPublishVersion() // = 0
    bumpPublishVersion() // now = 1

    // Old version is now stale
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=${oldVersion}`)
    const req = new Request(url)
    const res = await handleHoleRequest(req, url, { db })

    const body = await res.text()
    expect(body).toContain('instatic-hole-stale')
  })
})

// ---------------------------------------------------------------------------
// handleHoleRequest — version-keyed single-flight (no bespoke reset hook)
// ---------------------------------------------------------------------------

describe('handleHoleRequest — snapshot single-flight', () => {
  it('loads the published snapshot once for concurrent requests at the same version', async () => {
    const { db, count } = makeCountingDb(makeSnapshot())
    const currentVersion = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/text-node?v=${currentVersion}`)

    // Fire several concurrent requests for the same (nodeId, version). The
    // version-keyed single-flight memo must collapse them into one DB load.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => handleHoleRequest(new Request(url), url, { db })),
    )

    for (const res of results) {
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('Hello from hole')
    }
    expect(count()).toBe(1)
  })

  it('reloads after a version bump (memo is version-keyed)', async () => {
    const { db, count } = makeCountingDb(makeSnapshot())

    const v0 = getPublishVersion()
    const url0 = new URL(`http://localhost/_instatic/hole/text-node?v=${v0}`)
    await handleHoleRequest(new Request(url0), url0, { db })
    expect(count()).toBe(1)

    bumpPublishVersion()
    const v1 = getPublishVersion()
    const url1 = new URL(`http://localhost/_instatic/hole/text-node?v=${v1}`)
    await handleHoleRequest(new Request(url1), url1, { db })
    expect(count()).toBe(2)
  })
})
