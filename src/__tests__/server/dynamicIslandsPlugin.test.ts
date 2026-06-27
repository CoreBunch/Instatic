/**
 * Plugin dynamic islands (Layer C holes) — end-to-end confirmation.
 *
 * Exercises the full plugin loop-source path the feature work wired up:
 *   1. Protocol schema accepts `requestDependent` / `perVisitor`.
 *   2. Dynamic detection classifies a `base.loop` bound to a request-dependent
 *      OR per-visitor plugin source (Rule 3).
 *   3. The hole endpoint renders live, request-time data:
 *        - SHARED hole reads the page query, NOT cookies, and caches per query.
 *        - PER-VISITOR hole reads cookies, bypasses the cache (no-store), and
 *          re-runs the source fetch on every request.
 *   4. The snapshot is loaded from the DB once per publish version (the
 *      versioned snapshot cache), not per request.
 *
 * The loop sources here stand in for a plugin's registered sources — they are
 * inserted directly into the singleton `loopSourceRegistry`, which is exactly
 * what `server/plugins/host/handlers/loops.ts` does after the QuickJS bootstrap
 * + protocol decode.
 */

import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { Value } from '@sinclair/typebox/value'
import type { DbClient, DbResult } from '../../../server/db'
import { handleHoleRequest } from '../../../server/handlers/cms/hole'
import { resetForTests } from '../../../server/publish/renderCache'
import { getPublishVersion } from '../../../server/publish/publishState'
import { LoopSourceDescriptorSchema } from '../../../server/plugins/protocol/schemas/loops'
import { registry } from '../../core/module-engine/registry'
import type { AnyModuleDefinition } from '../../core/module-engine'
import { loopSourceRegistry } from '../../core/loops/registry'
import { findDynamicNodeIds } from '../../core/publisher/dynamicDetection'
import type { LoopEntitySource, SourceFetchContext } from '../../core/loops/types'
import { makeModule, makePage, makeSite } from '../publisher/helpers'

const LIVE_SOURCE_ID = 'acme.di.live'
const VISITOR_SOURCE_ID = 'acme.di.visitor'
const TEST_MODULE_IDS = ['test.body', 'test.text', 'base.loop'] as const

// Per-source fetch call counters so the tests can assert cache behaviour.
let liveCalls = 0
let visitorCalls = 0
let previousModules = new Map<string, AnyModuleDefinition | undefined>()

function snapshotTestModules() {
  previousModules = new Map(TEST_MODULE_IDS.map((id) => [id, registry.get(id)]))
}

function restoreTestModules() {
  for (const [id, definition] of previousModules) {
    if (definition) {
      registry.registerOrReplace(definition)
    } else {
      registry.unregister(id)
    }
  }
  previousModules.clear()
}

function makeLiveSource(): LoopEntitySource {
  return {
    id: LIVE_SOURCE_ID,
    label: 'Live (request-dependent)',
    requestDependent: true,
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'label', label: 'Label' }],
    fetch: async (ctx: SourceFetchContext) => {
      liveCalls++
      const q = ctx.request?.query?.q ?? ''
      const cookieCount = Object.keys(ctx.request?.cookies ?? {}).length
      return {
        items: [{ id: '1', fields: { label: `q=${q} cookies=${cookieCount}` } }],
        totalItems: 1,
      }
    },
    preview: () => [],
  }
}

function makeVisitorSource(): LoopEntitySource {
  return {
    id: VISITOR_SOURCE_ID,
    label: 'Per-visitor',
    perVisitor: true,
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'label', label: 'Label' }],
    fetch: async (ctx: SourceFetchContext) => {
      visitorCalls++
      const sid = ctx.request?.cookies?.sid ?? 'anon'
      return {
        items: [{ id: '1', fields: { label: `sid=${sid} call=${visitorCalls}` } }],
        totalItems: 1,
      }
    },
    preview: () => [],
  }
}

// ---------------------------------------------------------------------------
// Snapshot fixture: root → base.loop(sourceId) → text(child bound to label)
// ---------------------------------------------------------------------------

function makeSnapshotWithLoop(loopNodeId: string, sourceId: string) {
  const childId = `${loopNodeId}-child`
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
          slug: 'search',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'test.body',
              props: {},
              breakpointOverrides: {},
              children: [loopNodeId],
              classIds: [],
            },
            [loopNodeId]: {
              id: loopNodeId,
              moduleId: 'base.loop',
              props: { sourceId, pagination: 'none' },
              breakpointOverrides: {},
              children: [childId],
              classIds: [],
            },
            [childId]: {
              id: childId,
              moduleId: 'test.text',
              props: { text: 'fallback' },
              dynamicBindings: { text: { source: 'currentEntry', field: 'label' } },
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
      settings: { shortcuts: {} },
      styleRules: {},
      createdAt: 1000,
      updatedAt: 2000,
      packageJson: { dependencies: {}, devDependencies: {} },
      runtime: { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} },
    },
  }
}

/**
 * Minimal GET request stub. The hole handler only reads `req.method` and
 * `req.headers.get('cookie')`. We bypass the global `Headers` here because the
 * test runtime (happy-dom) enforces the browser forbidden-header rule and drops
 * the `Cookie` header — Bun.serve's native incoming Request does not, so a stub
 * faithfully models production while keeping the test deterministic.
 */
function makeReq(cookie?: string): Request {
  return {
    method: 'GET',
    headers: { get: (k: string) => (cookie && k.toLowerCase() === 'cookie' ? cookie : null) },
  } as unknown as Request
}

function makeFakeDb(
  snapshot: ReturnType<typeof makeSnapshotWithLoop> | null,
  counters?: { snapshotLoads: number },
): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
    if (sql.includes('site_snapshots.site_json')) {
      if (counters) counters.snapshotLoads++
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

beforeEach(() => {
  // `resetForTests` also clears the hole endpoint's version-keyed snapshot memo
  // via `resetPublishStateForTests` — no bespoke hole reset hook needed.
  resetForTests()
  snapshotTestModules()
  liveCalls = 0
  visitorCalls = 0
  registry.registerOrReplace(
    makeModule('test.body', { render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }) }),
  )
  registry.registerOrReplace(
    makeModule('test.text', { render: (p) => ({ html: `<span>${String(p['text'] ?? '')}</span>` }) }),
  )
  // base.loop only needs a registry entry so renderNode finds a def; the actual
  // iteration is handled by the specialised renderLoop dispatcher.
  registry.registerOrReplace(makeModule('base.loop', { canHaveChildren: true }))
  loopSourceRegistry.registerOrReplace(makeLiveSource())
  loopSourceRegistry.registerOrReplace(makeVisitorSource())
})

afterEach(() => {
  loopSourceRegistry.unregister(LIVE_SOURCE_ID)
  loopSourceRegistry.unregister(VISITOR_SOURCE_ID)
  restoreTestModules()
})

// ---------------------------------------------------------------------------
// Phase 1 — protocol schema
// ---------------------------------------------------------------------------

describe('loop source protocol schema', () => {
  const base = { id: 'acme.x', label: 'X', filterSchema: {}, orderByOptions: [], fields: [] }

  it('accepts requestDependent + perVisitor and preserves them through decode', () => {
    const descriptor = { ...base, requestDependent: true, perVisitor: true }
    expect(Value.Check(LoopSourceDescriptorSchema, descriptor)).toBe(true)
    const decoded = Value.Decode(LoopSourceDescriptorSchema, descriptor)
    expect(decoded.requestDependent).toBe(true)
    expect(decoded.perVisitor).toBe(true)
  })

  it('still accepts a descriptor with neither flag (built-in / static source)', () => {
    expect(Value.Check(LoopSourceDescriptorSchema, base)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Detection (Rule 3) — plugin sources classify their loop as dynamic
// ---------------------------------------------------------------------------

describe('findDynamicNodeIds — plugin loop sources', () => {
  it('classifies a base.loop bound to a requestDependent source as dynamic', () => {
    const page = makePage({
      root: { moduleId: 'test.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', props: { sourceId: LIVE_SOURCE_ID } },
    })
    const ids = findDynamicNodeIds(page, makeSite(), registry)
    expect(ids.has('loop')).toBe(true)
  })

  it('classifies a base.loop bound to a perVisitor source as dynamic', () => {
    const page = makePage({
      root: { moduleId: 'test.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', props: { sourceId: VISITOR_SOURCE_ID } },
    })
    expect(findDynamicNodeIds(page, makeSite(), registry).has('loop')).toBe(true)
  })

  it('leaves a loop bound to an unregistered/static source static', () => {
    const page = makePage({
      root: { moduleId: 'test.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', props: { sourceId: 'acme.does-not-exist' } },
    })
    expect(findDynamicNodeIds(page, makeSite(), registry).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Hole endpoint — SHARED (requestDependent) live render
// ---------------------------------------------------------------------------

describe('hole endpoint — shared (requestDependent) hole', () => {
  it('renders request-time data from route.query and does NOT expose cookies', async () => {
    const snap = makeSnapshotWithLoop('hole-loop', LIVE_SOURCE_ID)
    const db = makeFakeDb(snap)
    const v = getPublishVersion()
    const u = encodeURIComponent('/search?q=shoes')
    const url = new URL(`http://localhost/_instatic/hole/hole-loop?v=${v}&u=${u}`)
    const res = await handleHoleRequest(makeReq('sid=secret'), url, { db })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('q=shoes')
    // Cookies must NOT leak into a shared (cacheable) hole.
    expect(body).toContain('cookies=0')
  })

  it('caches per query: same query reuses the render, different query re-fetches', async () => {
    const snap = makeSnapshotWithLoop('hole-loop', LIVE_SOURCE_ID)
    const db = makeFakeDb(snap)
    const v = getPublishVersion()

    const hit = async (q: string) => {
      const url = new URL(`http://localhost/_instatic/hole/hole-loop?v=${v}&u=${encodeURIComponent(`/search?q=${q}`)}`)
      return (await handleHoleRequest(makeReq(), url, { db })).text()
    }

    const a1 = await hit('shoes')
    const a2 = await hit('shoes')
    expect(a1).toBe(a2)
    expect(liveCalls).toBe(1) // second identical query served from Layer B

    const b1 = await hit('hats')
    expect(b1).toContain('q=hats')
    expect(liveCalls).toBe(2) // distinct query → distinct cache slot → re-fetch
  })
})

// ---------------------------------------------------------------------------
// Hole endpoint — PER-VISITOR hole
// ---------------------------------------------------------------------------

describe('hole endpoint — per-visitor hole', () => {
  it('reads cookies, bypasses the cache (no-store), and re-renders every request', async () => {
    const snap = makeSnapshotWithLoop('hole-loop', VISITOR_SOURCE_ID)
    const db = makeFakeDb(snap)
    const v = getPublishVersion()
    const url = new URL(`http://localhost/_instatic/hole/hole-loop?v=${v}&u=${encodeURIComponent('/')}`)

    const res1 = await handleHoleRequest(makeReq('sid=alice'), url, { db })
    expect(res1.headers.get('cache-control')).toBe('no-store')
    const body1 = await res1.text()
    expect(body1).toContain('sid=alice')
    expect(body1).toContain('call=1')

    // Second request: NOT cached — fetch runs again (call counter advances),
    // and a different visitor sees their own cookie value.
    const res2 = await handleHoleRequest(makeReq('sid=bob'), url, { db })
    const body2 = await res2.text()
    expect(body2).toContain('sid=bob')
    expect(body2).toContain('call=2')
    expect(visitorCalls).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Polish — versioned snapshot cache
// ---------------------------------------------------------------------------

describe('hole endpoint — versioned snapshot cache', () => {
  it('loads the published snapshot from the DB once per publish version', async () => {
    const snap = makeSnapshotWithLoop('hole-loop', LIVE_SOURCE_ID)
    const counters = { snapshotLoads: 0 }
    const db = makeFakeDb(snap, counters)
    const v = getPublishVersion()

    for (const q of ['a', 'b', 'c']) {
      const url = new URL(`http://localhost/_instatic/hole/hole-loop?v=${v}&u=${encodeURIComponent(`/s?q=${q}`)}`)
      await handleHoleRequest(makeReq(), url, { db })
    }
    // Three distinct requests, one snapshot DB read.
    expect(counters.snapshotLoads).toBe(1)
  })
})
