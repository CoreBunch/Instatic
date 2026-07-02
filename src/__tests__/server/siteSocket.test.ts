/**
 * Site socket — the live-pull channel's server half (multi-admin level B).
 *
 * Covered here:
 *   - upgrade gating: no session → 401; wrong Origin → 403 (CSWSH defense);
 *     authenticated non-WS request → 426; authenticated WS handshake →
 *     upgraded (null),
 *   - post-commit event emission from the transactional save: rows-changed /
 *     rows-deleted / shell-changed carry the save's seq and actor; a
 *     replace-mode save emits ONE site-reloaded; row-only saves emit no
 *     shell-changed,
 *   - the reconnect delta (`computeDeltaEvents`): rows past the cursor
 *     surface as changed/deleted hints (soft-deleted included), the shell
 *     only when its seq is past the cursor, nothing at the live cursor,
 *   - a REAL WebSocket round-trip against `Bun.serve`: subscribe → delta,
 *     then a live save fans out through the bus to the open socket.
 *
 * Uses the capability harness for auth/session/save plumbing; the publisher
 * is injected per test via `setSiteEventPublisher` and detached afterwards
 * (the module-global default is null — handlers drop events silently).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import type { SiteSyncEvent } from '@core/persistence/syncEvents'
import { publishSiteEvent, setSiteEventPublisher, SITE_EVENTS_TOPIC } from '../../../server/events/siteEvents'
import {
  computeDeltaEvents,
  createSiteSocketHandlers,
  handleSiteSocketUpgrade,
  SITE_SOCKET_PATH,
  type SiteSocketData,
} from '../../../server/events/siteSocket'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

afterEach(() => {
  setSiteEventPublisher(null)
})

// ---------------------------------------------------------------------------
// Shared save plumbing (mirrors siteDocumentSave.test.ts, trimmed)
// ---------------------------------------------------------------------------

function pagePayload(id: string, slug: string, title = slug): Record<string, unknown> {
  const rootId = `root-${id}`
  return {
    id,
    slug,
    title,
    rootNodeId: rootId,
    nodes: {
      [rootId]: { id: rootId, moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [] },
    },
  }
}

interface Ctx {
  harness: CapabilityTestHarness
  cookie: string
  shell: SiteShell
}

async function setupHarness(): Promise<Ctx> {
  const harness = await createCapabilityTestHarness()
  const cookie = await harness.setupOwner()
  const shellRes = await harness.cms('/admin/api/cms/site', { method: 'GET', cookie })
  const { site: shell } = await readJson<{ site: SiteShell }>(shellRes)
  return { harness, cookie, shell }
}

async function liveBaseSeqs(harness: CapabilityTestHarness, ids: string[]): Promise<Record<string, number>> {
  const { rows } = await harness.db<{ id: string; seq: number }>`select id, seq from data_rows`
  const wanted = new Set(ids)
  return Object.fromEntries(rows.filter((r) => wanted.has(r.id)).map((r) => [r.id, Number(r.seq)]))
}

async function putDoc(
  ctx: Ctx,
  overrides: {
    mode?: 'incremental' | 'replace'
    site?: unknown
    changedPages?: unknown[]
    deletedPageIds?: string[]
  } = {},
): Promise<number> {
  const json = {
    mode: 'incremental' as const,
    site: ctx.shell,
    changedPages: [] as unknown[],
    deletedPageIds: [] as string[],
    changedComponents: [],
    deletedComponentIds: [],
    changedLayouts: [],
    deletedLayoutIds: [],
    ...overrides,
  }
  const ids = [
    ...json.changedPages
      .map((p) => (p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string'),
    ...json.deletedPageIds,
  ]
  const res = await ctx.harness.cms('/admin/api/cms/site-document', {
    method: 'PUT',
    cookie: ctx.cookie,
    json: { ...json, baseSeqs: await liveBaseSeqs(ctx.harness, ids), shellBaseSeq: 0 },
  })
  expect(res.status).toBe(200)
  const body = await readJson<{ seq: number }>(res)
  return body.seq
}

/** Capture bus output for one test. */
function captureEvents(): SiteSyncEvent[] {
  const events: SiteSyncEvent[] = []
  setSiteEventPublisher({
    publish: (_topic, data) => {
      events.push(JSON.parse(data) as SiteSyncEvent)
      return 0
    },
  })
  return events
}

// ---------------------------------------------------------------------------
// Upgrade gating
// ---------------------------------------------------------------------------

describe('site socket — upgrade gating', () => {
  function fakeServer(upgradeResult: boolean): { upgrade: () => boolean; upgraded: () => boolean } {
    let upgraded = false
    return {
      upgrade: () => {
        upgraded = true
        return upgradeResult
      },
      upgraded: () => upgraded,
    }
  }

  it('rejects an unauthenticated handshake with 401 before upgrading', async () => {
    const ctx = await setupHarness()
    try {
      const server = fakeServer(true)
      const res = await handleSiteSocketUpgrade(
        new Request(`http://localhost${SITE_SOCKET_PATH}`),
        ctx.harness.db,
        server,
      )
      expect(res?.status).toBe(401)
      expect(server.upgraded()).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  /** `cookie`/`origin` are fetch-forbidden constructor headers — set after construction. */
  function socketRequest(headers: Record<string, string>): Request {
    const req = new Request(`http://localhost${SITE_SOCKET_PATH}`)
    for (const [name, value] of Object.entries(headers)) req.headers.set(name, value)
    return req
  }

  it('rejects a cross-origin handshake with 403 (CSWSH defense) even with a valid session', async () => {
    const ctx = await setupHarness()
    try {
      const server = fakeServer(true)
      const req = socketRequest({ cookie: ctx.cookie, origin: 'https://evil.example' })
      const res = await handleSiteSocketUpgrade(req, ctx.harness.db, server)
      expect(res?.status).toBe(403)
      expect(server.upgraded()).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('upgrades an authenticated same-origin handshake; a non-WS request gets 426', async () => {
    const ctx = await setupHarness()
    try {
      const req = socketRequest({ cookie: ctx.cookie })
      expect(await handleSiteSocketUpgrade(req, ctx.harness.db, fakeServer(true))).toBeNull()
      const rejected = await handleSiteSocketUpgrade(
        socketRequest({ cookie: ctx.cookie }),
        ctx.harness.db,
        fakeServer(false),
      )
      expect(rejected?.status).toBe(426)
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Save emission
// ---------------------------------------------------------------------------

describe('site socket — save event emission', () => {
  it('an incremental save emits rows-changed/rows-deleted with the save seq and actor, and NO shell event on row-only saves', async () => {
    const ctx = await setupHarness()
    try {
      const events = captureEvents()
      const createSeq = await putDoc(ctx, { changedPages: [pagePayload('page-a', 'about')] })
      const deleteSeq = await putDoc(ctx, { deletedPageIds: ['page-a'] })

      expect(events).toEqual([
        {
          kind: 'rows-changed',
          table: 'pages',
          seqs: { 'page-a': createSeq },
          actor: { userId: expect.any(String), name: expect.any(String) },
        },
        {
          kind: 'rows-deleted',
          table: 'pages',
          seqs: { 'page-a': deleteSeq },
          actor: { userId: expect.any(String), name: expect.any(String) },
        },
      ])
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a shell change emits shell-changed; a replace-mode save emits ONE site-reloaded', async () => {
    const ctx = await setupHarness()
    try {
      const events = captureEvents()
      const shellSeq = await putDoc(ctx, { site: { ...ctx.shell, name: 'Renamed' } })
      expect(events).toEqual([
        expect.objectContaining({ kind: 'shell-changed', seq: shellSeq }),
      ])

      events.length = 0
      const replaceSeq = await putDoc(ctx, {
        mode: 'replace',
        site: { ...ctx.shell, name: 'Imported site' },
        changedPages: [pagePayload('page-b', 'contact')],
      })
      expect(events).toEqual([
        expect.objectContaining({ kind: 'site-reloaded', seq: replaceSeq }),
      ])
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Reconnect delta
// ---------------------------------------------------------------------------

describe('site socket — reconnect delta', () => {
  it('synthesizes changed + deleted row hints past the cursor, and nothing at the live cursor', async () => {
    const ctx = await setupHarness()
    try {
      const seqA = await putDoc(ctx, { changedPages: [pagePayload('page-a', 'about')] })
      const seqB = await putDoc(ctx, { changedPages: [pagePayload('page-b', 'contact')] })
      const seqDel = await putDoc(ctx, { deletedPageIds: ['page-a'] })

      // Cursor 0 → everything: page-a surfaces as DELETED (its latest state),
      // page-b as changed. No shell event — row-only saves never stamped it.
      const fromZero = await computeDeltaEvents(ctx.harness.db, 0)
      expect(fromZero).toEqual([
        { kind: 'rows-changed', table: 'pages', seqs: { 'page-b': seqB } },
        { kind: 'rows-deleted', table: 'pages', seqs: { 'page-a': seqDel } },
      ])

      // Mid cursor → only what came after.
      const fromA = await computeDeltaEvents(ctx.harness.db, seqA)
      expect(fromA).toEqual([
        { kind: 'rows-changed', table: 'pages', seqs: { 'page-b': seqB } },
        { kind: 'rows-deleted', table: 'pages', seqs: { 'page-a': seqDel } },
      ])

      // Live cursor → empty delta.
      expect(await computeDeltaEvents(ctx.harness.db, seqDel)).toEqual([])
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('includes shell-changed only when the shell seq is past the cursor', async () => {
    const ctx = await setupHarness()
    try {
      const shellSeq = await putDoc(ctx, { site: { ...ctx.shell, name: 'Renamed' } })
      const delta = await computeDeltaEvents(ctx.harness.db, 0)
      expect(delta).toEqual([{ kind: 'shell-changed', seq: shellSeq }])
      expect(await computeDeltaEvents(ctx.harness.db, shellSeq)).toEqual([])
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Real WebSocket round-trip
// ---------------------------------------------------------------------------

describe('site socket — WebSocket round-trip', () => {
  it('subscribe returns the delta, and a live publish fans out to the open socket', async () => {
    const ctx = await setupHarness()
    const seqA = await putDoc(ctx, { changedPages: [pagePayload('page-a', 'about')] })

    const server = Bun.serve<SiteSocketData, Record<string, never>>({
      port: 0,
      async fetch(req, srv) {
        const rejection = await handleSiteSocketUpgrade(req, ctx.harness.db, srv)
        return rejection === null ? undefined : rejection
      },
      websocket: createSiteSocketHandlers(ctx.harness.db),
    })

    try {
      setSiteEventPublisher(server)

      const received: SiteSyncEvent[] = []
      const gotDelta = Promise.withResolvers<void>()
      const gotLive = Promise.withResolvers<void>()

      const ws = new WebSocket(`ws://localhost:${server.port}${SITE_SOCKET_PATH}`, {
        headers: { cookie: ctx.cookie },
      })
      ws.onmessage = (msg) => {
        received.push(JSON.parse(String(msg.data)) as SiteSyncEvent)
        if (received.length === 1) gotDelta.resolve()
        if (received.length === 2) gotLive.resolve()
      }
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('socket failed to open'))
      })

      ws.send(JSON.stringify({ kind: 'subscribe', cursor: 0 }))
      await gotDelta.promise
      expect(received[0]).toEqual({
        kind: 'rows-changed',
        table: 'pages',
        seqs: { 'page-a': seqA },
      })

      // Live fan-out through the bus (same path the save handler uses).
      publishSiteEvent({ kind: 'shell-changed', seq: seqA + 1 })
      await gotLive.promise
      expect(received[1]).toEqual({ kind: 'shell-changed', seq: seqA + 1 })

      ws.close()
    } finally {
      server.stop(true)
      await ctx.harness.cleanup()
    }
  })
})
