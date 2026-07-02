/**
 * Site socket — the WebSocket endpoint of the multi-admin live-pull channel.
 *
 *   GET /admin/api/cms/site-socket → WebSocket upgrade
 *
 * Auth happens at upgrade time: the session cookie must resolve to a user
 * with `site.read`, and the Origin header must pass `originAllowed` — the
 * browser always sends Origin on WebSocket handshakes, so this closes
 * cross-origin WebSocket hijacking (CSWSH): cookies ride the handshake, but
 * a foreign origin is rejected before the socket opens.
 *
 * Protocol (shapes in @core/persistence/syncEvents):
 *   1. On open the socket subscribes to the `site` topic — every
 *      post-commit save event published through server/events/siteEvents
 *      fans out to it via Bun's native pub/sub (subscriptions die with the
 *      socket; no cleanup bookkeeping to leak).
 *   2. The client sends `{ kind: 'subscribe', cursor }` with the highest
 *      seq it has synchronized. The server replies with DELTA events
 *      synthesized from `rows where seq > cursor` (soft-deleted included —
 *      a missed deletion surfaces as `rows-deleted`, not silence) plus a
 *      `shell-changed` when the shell seq is past the cursor. This makes
 *      the socket self-healing: live events are hints; the delta is truth.
 *   3. Malformed or non-string frames are logged and dropped — never acted
 *      on.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun'
import type { SiteSyncEvent, SiteSyncTable } from '@core/persistence/syncEvents'
import { SITE_SOCKET_PATH, SiteSocketSubscribeSchema } from '@core/persistence/syncEvents'
import { safeParseJson } from '@core/utils/jsonValidate'
import { requireCapability } from '../auth/authz'
import { originAllowed } from '../auth/security'
import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import { listChangedDataRowRefsSince } from '../repositories/data'
import { getDraftSiteSeq } from '../repositories/site'
import { SITE_EVENTS_TOPIC } from './siteEvents'

export { SITE_SOCKET_PATH }

export interface SiteSocketData {
  userId: string
}

const SITE_SYNC_TABLES: readonly SiteSyncTable[] = ['pages', 'components', 'layouts']

interface UpgradeCapableServer {
  upgrade(req: Request, options: { data: SiteSocketData }): boolean
}

/**
 * Gate + upgrade the socket request. Returns `null` when the connection was
 * upgraded (the caller must then return `undefined` from `fetch`), or an
 * error `Response` (401/403/426) to send instead.
 */
export async function handleSiteSocketUpgrade(
  req: Request,
  db: DbClient,
  server: UpgradeCapableServer,
): Promise<Response | null> {
  // CSWSH defense — a cookie-bearing cross-origin handshake is rejected
  // before auth even runs.
  if (!originAllowed(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, { status: 403 })
  }
  const user = await requireCapability(req, db, 'site.read')
  if (user instanceof Response) return user
  const upgraded = server.upgrade(req, { data: { userId: user.id } })
  if (!upgraded) {
    return jsonResponse({ error: 'WebSocket upgrade required' }, { status: 426 })
  }
  return null
}

/**
 * Reconnect delta: every sync event the client with this cursor has missed,
 * in seq order, ready to run through the client's ordinary merge rule.
 * Delta events carry no actor — the originating saves are no longer known.
 */
export async function computeDeltaEvents(db: DbClient, cursor: number): Promise<SiteSyncEvent[]> {
  const refs = await listChangedDataRowRefsSince(db, SITE_SYNC_TABLES, cursor)

  const changed = new Map<SiteSyncTable, Record<string, number>>()
  const deleted = new Map<SiteSyncTable, Record<string, number>>()
  for (const ref of refs) {
    const table = ref.tableId as SiteSyncTable // query is scoped to SITE_SYNC_TABLES
    const bucket = ref.deleted ? deleted : changed
    const seqs = bucket.get(table) ?? {}
    seqs[ref.id] = ref.seq
    bucket.set(table, seqs)
  }

  const events: SiteSyncEvent[] = []
  for (const [table, seqs] of changed) events.push({ kind: 'rows-changed', table, seqs })
  for (const [table, seqs] of deleted) events.push({ kind: 'rows-deleted', table, seqs })

  const shellSeq = await getDraftSiteSeq(db)
  if (shellSeq > cursor) events.push({ kind: 'shell-changed', seq: shellSeq })

  return events
}

/** The `websocket` config for `Bun.serve` — one instance per boot, bound to the db. */
export function createSiteSocketHandlers(db: DbClient): WebSocketHandler<SiteSocketData> {
  return {
    open(ws: ServerWebSocket<SiteSocketData>) {
      ws.subscribe(SITE_EVENTS_TOPIC)
    },

    async message(ws: ServerWebSocket<SiteSocketData>, raw: string | Buffer) {
      if (typeof raw !== 'string') return // binary frames are not part of the protocol
      const parsed = safeParseJson(raw, SiteSocketSubscribeSchema)
      if (!parsed.ok) {
        console.warn('[siteSocket] dropping malformed client message')
        return
      }
      try {
        const events = await computeDeltaEvents(db, parsed.value.cursor)
        for (const event of events) ws.send(JSON.stringify(event))
      } catch (err) {
        console.error('[siteSocket] delta computation failed:', err)
      }
    },

    close() {
      // Bun drops the socket's topic subscriptions automatically.
    },
  }
}
