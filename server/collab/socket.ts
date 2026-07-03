/**
 * Collab socket — the WebSocket endpoint of real-time co-editing.
 *
 *   GET /admin/api/cms/site-socket → WebSocket upgrade
 *
 * Auth happens at upgrade time: the session cookie must resolve to a user
 * with `site.read`, and the Origin header must pass `originAllowed` — the
 * browser always sends Origin on WebSocket handshakes, so this closes
 * cross-origin WebSocket hijacking (CSWSH): cookies ride the handshake, but
 * a foreign origin is rejected before the socket opens. Whether the user may
 * WRITE is resolved once at upgrade (any site-write capability) — update
 * frames from read-only connections are dropped server-side.
 *
 * One socket multiplexes many docs (frames in @core/collab/protocol):
 *   - FRAME_SYNC: y-protocols sync messages per doc. A connection's first
 *     sync frame for a doc retains it in the relay and subscribes the socket
 *     to that doc's fan-out topic; close releases everything.
 *   - FRAME_AWARENESS: one site-wide awareness channel (PRESENCE_DOC_ID) —
 *     cursors/selections; per-connection clientIDs are tracked so a closing
 *     socket's peers disappear immediately.
 *   - FRAME_RESET: server → client only; broadcast when the relay drops a
 *     doc whose backing JSON was rewritten out-of-relay.
 *
 * NOTE on fan-out: relay updates publish to every topic subscriber including
 * the originator — Yjs update application is idempotent, so the echo is a
 * cheap no-op and the code stays free of per-connection exclusion plumbing.
 */
import type { ServerWebSocket, WebSocketHandler } from 'bun'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  decodeCollabFrame,
  encodeCollabFrame,
  FRAME_AWARENESS,
  FRAME_RESET,
  FRAME_SYNC,
  parseCollabDocId,
  PRESENCE_DOC_ID,
  SITE_SOCKET_PATH,
} from '@core/collab'
import { requireCapability, userHasCapability } from '../auth/authz'
import { originAllowed } from '../auth/security'
import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import type { CollabRelay } from './relay'

export { SITE_SOCKET_PATH }

const SITE_WRITE_CAPABILITIES = ['site.structure.edit', 'site.content.edit', 'site.style.edit'] as const

/** y-protocols/sync message types (the payload's first varUint). */
const SYNC_STEP_1 = 0

export interface CollabSocketData {
  userId: string
  canWrite: boolean
  /** Doc ids this connection retained in the relay (released on close). */
  boundDocs: Set<string>
  /** Awareness clientIDs contributed by this connection. */
  awarenessClients: Set<number>
}

interface UpgradeCapableServer {
  upgrade(req: Request, options: { data: CollabSocketData }): boolean
}

/**
 * Gate + upgrade the socket request. Returns `null` when the connection was
 * upgraded (the caller must then return `undefined` from `fetch`), or an
 * error `Response` (401/403/426) to send instead.
 */
export async function handleCollabSocketUpgrade(
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
  const canWrite = SITE_WRITE_CAPABILITIES.some((cap) => userHasCapability(user, cap))
  const upgraded = server.upgrade(req, {
    data: { userId: user.id, canWrite, boundDocs: new Set(), awarenessClients: new Set() },
  })
  if (!upgraded) {
    return jsonResponse({ error: 'WebSocket upgrade required' }, { status: 426 })
  }
  return null
}

const docTopic = (docId: string): string => `collab:${docId}`

interface CollabPublisher {
  publish(topic: string, data: Uint8Array): number
}

/**
 * Wire the relay's fan-out to Bun pub/sub. Call once after `Bun.serve`
 * returns (the server handle is the publisher). Also owns the site-wide
 * awareness instance.
 */
export function createCollabSocketLayer(relay: CollabRelay) {
  let publisher: CollabPublisher | null = null
  const presenceDoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(presenceDoc)
  // The server never contributes its own presence state.
  awareness.setLocalState(null)

  relay.subscribeUpdates((docId, update) => {
    if (!publisher) return
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, update)
    publisher.publish(docTopic(docId), encodeCollabFrame(docId, FRAME_SYNC, encoding.toUint8Array(encoder)))
  })
  relay.onReset((docId) => {
    publisher?.publish(docTopic(docId), encodeCollabFrame(docId, FRAME_RESET, new Uint8Array()))
  })

  const handlers: WebSocketHandler<CollabSocketData> = {
    open(ws: ServerWebSocket<CollabSocketData>) {
      ws.subscribe(docTopic(PRESENCE_DOC_ID))
      // Late joiners need the current presence roster.
      const known = [...awareness.getStates().keys()]
      if (known.length > 0) {
        const update = awarenessProtocol.encodeAwarenessUpdate(awareness, known)
        ws.send(encodeCollabFrame(PRESENCE_DOC_ID, FRAME_AWARENESS, update))
      }
    },

    async message(ws: ServerWebSocket<CollabSocketData>, raw: string | Buffer) {
      if (typeof raw === 'string') return // binary protocol only
      const frame = decodeCollabFrame(new Uint8Array(raw))

      if (frame.frameType === FRAME_AWARENESS) {
        if (!ws.data.canWrite) return
        // Track which clientIDs this connection contributes so its peers
        // vanish immediately on close.
        const before = new Set(awareness.getStates().keys())
        awarenessProtocol.applyAwarenessUpdate(awareness, frame.payload, ws)
        for (const clientId of awareness.getStates().keys()) {
          if (!before.has(clientId)) ws.data.awarenessClients.add(clientId)
        }
        publisher?.publish(
          docTopic(PRESENCE_DOC_ID),
          encodeCollabFrame(PRESENCE_DOC_ID, FRAME_AWARENESS, frame.payload),
        )
        // publish() excludes nobody server-side; the sender's own state is
        // already local — awareness re-application is idempotent.
        ws.send(encodeCollabFrame(PRESENCE_DOC_ID, FRAME_AWARENESS, frame.payload))
        return
      }

      if (frame.frameType !== FRAME_SYNC) return
      if (!parseCollabDocId(frame.docId)) return

      // Read-only connections may REQUEST state (step1) but never write.
      const messageType = decoding.readVarUint(decoding.createDecoder(frame.payload))
      if (messageType !== SYNC_STEP_1 && !ws.data.canWrite) return

      let doc: Y.Doc
      if (ws.data.boundDocs.has(frame.docId)) {
        doc = await relay.openDoc(frame.docId)
      } else {
        doc = await relay.retain(frame.docId)
        ws.data.boundDocs.add(frame.docId)
        ws.subscribe(docTopic(frame.docId))
      }

      const decoder = decoding.createDecoder(frame.payload)
      const encoder = encoding.createEncoder()
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
      if (encoding.length(encoder) > 0) {
        ws.send(encodeCollabFrame(frame.docId, FRAME_SYNC, encoding.toUint8Array(encoder)))
      }
    },

    close(ws: ServerWebSocket<CollabSocketData>) {
      for (const docId of ws.data.boundDocs) relay.release(docId)
      ws.data.boundDocs.clear()
      if (ws.data.awarenessClients.size > 0) {
        awarenessProtocol.removeAwarenessStates(awareness, [...ws.data.awarenessClients], 'disconnect')
        const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [...ws.data.awarenessClients])
        publisher?.publish(
          docTopic(PRESENCE_DOC_ID),
          encodeCollabFrame(PRESENCE_DOC_ID, FRAME_AWARENESS, update),
        )
      }
    },
  }

  return {
    handlers,
    setPublisher(next: CollabPublisher): void {
      publisher = next
    },
    awareness,
  }
}
