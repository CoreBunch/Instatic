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
  encodeResetPayload,
  FRAME_AWARENESS,
  FRAME_RESET,
  FRAME_SYNC,
  parseCollabDocId,
  PRESENCE_DOC_ID,
  SITE_SOCKET_PATH,
  type CollabFrame,
  type ResetReason,
} from '@core/collab'
import { requireCapability, userHasCapability } from '../auth/authz'
import { safeParseValue, Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import { validateGuardedUpdate } from './updateGuard'
import { originAllowed } from '../auth/security'
import type { DbClient } from '../db/client'
import { jsonResponse } from '../http'
import type { CollabRelay, RelayDoc } from './relay'

export { SITE_SOCKET_PATH }

const SITE_WRITE_CAPABILITIES = ['site.structure.edit', 'site.content.edit', 'site.style.edit'] as const

/** y-protocols/sync message types (the payload's first varUint). */
const SYNC_STEP_1 = 0

// Frame-size ceilings (belt and braces on top of Bun's maxPayloadLength):
// presence states are a few hundred bytes; doc updates can legitimately be
// large (a big paste, a whole-doc repopulate) but never tens of megabytes.
const MAX_AWARENESS_PAYLOAD_BYTES = 64 * 1024
const MAX_SYNC_PAYLOAD_BYTES = 4 * 1024 * 1024

/** The canonical presence identity a connection is allowed to publish. */
export interface CollabPresenceIdentity {
  id: string
  name: string
  avatarUrl: string | null
  gravatarHash: string
}

// Validate (not `as`-cast) the identity block of a decoded awareness state —
// TypeBox at the JSON.parse boundary, per the boundary-validation rule.
const PresenceUserSchema = Type.Object(
  {
    user: Type.Object({
      id: Type.String(),
      name: Type.String(),
      avatarUrl: Type.Union([Type.String(), Type.Null()]),
      gravatarHash: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  { additionalProperties: true },
)

/**
 * Why a client's awareness frame was refused — the relay drops all three, but
 * only two of them mean anything.
 *
 * `foreignClear` is ROUTINE, not an attack. Every y-protocols client runs
 * `checkOutdatedAwarenessStates` and broadcasts a removal for any peer whose
 * heartbeat it stopped hearing, so clients constantly try to clear clientIDs
 * they do not own. The relay refuses — presence is cleared only by its owner or
 * by that owner's disconnect, or one slow peer could erase another for everyone
 * — but this is expected protocol chatter and must never be logged as a
 * security event.
 *
 * `impersonation` and `malformed` are the ones worth hearing about.
 */
type AwarenessRefusal = 'impersonation' | 'foreignClear' | 'malformed'

/**
 * A client may only publish presence that matches ITS OWN session, and may only
 * clear clientIDs it contributed. Decode the awareness update (varUint count,
 * then per client: varUint id, varUint clock, varString stateJSON) and:
 *   - refuse any non-null state whose full identity (id + name + avatar +
 *     gravatar) differs from the session — pinning id alone let a peer keep its
 *     own id but paint another admin's name/avatar in every UI;
 *   - refuse a `null` (clear) for a clientID this connection never announced.
 *
 * Returns `null` when the frame is legitimate and may be applied.
 */
function reviewAwarenessUpdate(
  payload: Uint8Array,
  data: Pick<CollabSocketData, 'identity' | 'awarenessClients'>,
): AwarenessRefusal | null {
  try {
    const decoder = decoding.createDecoder(payload)
    const count = decoding.readVarUint(decoder)
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder)
      decoding.readVarUint(decoder) // clock
      const raw = decoding.readVarString(decoder)
      if (raw === 'null') {
        if (!data.awarenessClients.has(clientId)) return 'foreignClear'
        continue
      }
      const parsed = safeParseValue(PresenceUserSchema, JSON.parse(raw))
      if (!parsed.ok) return 'malformed'
      const u = parsed.value.user
      if (
        u.id !== data.identity.id ||
        u.name !== data.identity.name ||
        u.avatarUrl !== data.identity.avatarUrl ||
        u.gravatarHash !== data.identity.gravatarHash
      ) {
        return 'impersonation'
      }
    }
    return null
  } catch {
    // Undecodable update — refuse rather than relay garbage.
    return 'malformed'
  }
}

export interface CollabSocketData {
  userId: string
  /** The session identity this connection may publish over presence. */
  identity: CollabPresenceIdentity
  canWrite: boolean
  /**
   * True when the user holds ALL of SITE_WRITE_CAPABILITIES — the common
   * case, which skips the per-update capability guard entirely. Partial
   * writers (e.g. content-only editors) pay a fork+diff validation per
   * update frame instead (see ./updateGuard.ts).
   */
  fullSiteWriter: boolean
  /** The user's granted capabilities — the guard's validation input. */
  capabilities: readonly CoreCapability[]
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
  const fullSiteWriter = SITE_WRITE_CAPABILITIES.every((cap) => userHasCapability(user, cap))
  const upgraded = server.upgrade(req, {
    data: {
      userId: user.id,
      identity: {
        id: user.id,
        name: user.displayName,
        avatarUrl: user.avatarUrl,
        gravatarHash: user.gravatarHash,
      },
      canWrite,
      fullSiteWriter,
      capabilities: user.capabilities,
      boundDocs: new Set(),
      awarenessClients: new Set(),
    },
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

  relay.subscribeUpdates((docId, update, _origin, generation) => {
    if (!publisher) return
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, update)
    publisher.publish(
      docTopic(docId),
      encodeCollabFrame(docId, generation, FRAME_SYNC, encoding.toUint8Array(encoder)),
    )
  })
  relay.onReset((docId) => {
    // The lineage this frame refers to is already gone, so it carries none.
    publisher?.publish(
      docTopic(docId),
      encodeCollabFrame(docId, '', FRAME_RESET, encodeResetPayload('rewritten')),
    )
  })

  /** Tell one connection its doc was dropped, and why. */
  function sendReset(
    ws: ServerWebSocket<CollabSocketData>,
    docId: string,
    reason: ResetReason,
  ): void {
    ws.send(encodeCollabFrame(docId, '', FRAME_RESET, encodeResetPayload(reason)))
  }

  /**
   * Dispatch one decoded frame. Extracted so `message` can wrap it in a
   * single try/catch — a malformed frame or a projection crash inside the
   * guard must NOT escape as an unhandled rejection.
   */
  async function dispatchFrame(
    ws: ServerWebSocket<CollabSocketData>,
    frame: CollabFrame,
  ): Promise<void> {
      if (frame.frameType === FRAME_AWARENESS) {
        // Presence is NOT a doc write — read-only viewers are visible peers.
        if (frame.payload.byteLength > MAX_AWARENESS_PAYLOAD_BYTES) return
        const refusal = reviewAwarenessUpdate(frame.payload, ws.data)
        if (refusal !== null) {
          // A foreign clear is ordinary y-protocols timeout chatter (see
          // AwarenessRefusal) — drop it without crying wolf in the log.
          if (refusal !== 'foreignClear') {
            console.warn(`[collab] dropped ${refusal} awareness frame from ${ws.data.userId}`)
          }
          return
        }
        // Track which clientIDs this connection contributes so its peers
        // vanish immediately on close.
        const before = new Set(awareness.getStates().keys())
        awarenessProtocol.applyAwarenessUpdate(awareness, frame.payload, ws)
        for (const clientId of awareness.getStates().keys()) {
          if (!before.has(clientId)) ws.data.awarenessClients.add(clientId)
        }
        publisher?.publish(
          docTopic(PRESENCE_DOC_ID),
          encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_AWARENESS, frame.payload),
        )
        // publish() excludes nobody server-side; the sender's own state is
        // already local — awareness re-application is idempotent.
        ws.send(encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_AWARENESS, frame.payload))
        return
      }

      if (frame.frameType !== FRAME_SYNC) return
      if (!parseCollabDocId(frame.docId)) return
      if (frame.payload.byteLength > MAX_SYNC_PAYLOAD_BYTES) {
        console.warn(
          `[collab] oversize ${frame.docId} frame (${frame.payload.byteLength}B) from ${ws.data.userId}`,
        )
        // Silently dropping this diverges the client permanently: it holds
        // structs the server will never receive, every later update queues
        // behind them as pending, and the screen shows edits that can never
        // publish. A visible revert is strictly better.
        sendReset(ws, frame.docId, 'oversize')
        return
      }

      // Read-only connections may REQUEST state (step1) but never write.
      const messageType = decoding.readVarUint(decoding.createDecoder(frame.payload))
      if (messageType !== SYNC_STEP_1 && !ws.data.canWrite) return

      let bound: RelayDoc
      if (ws.data.boundDocs.has(frame.docId)) {
        bound = await relay.openDoc(frame.docId)
      } else {
        // Claim the doc SYNCHRONOUSLY before awaiting retain — otherwise two
        // concurrent frames for the same not-yet-bound doc both take this
        // branch and double-increment refs (close releases only once, leaking
        // the entry). A racing frame now sees boundDocs and takes openDoc.
        ws.data.boundDocs.add(frame.docId)
        ws.subscribe(docTopic(frame.docId))
        try {
          bound = await relay.retain(frame.docId)
        } catch (err) {
          ws.data.boundDocs.delete(frame.docId)
          ws.unsubscribe(docTopic(frame.docId))
          throw err
        }
      }
      const { doc, generation } = bound

      // LINEAGE CHECK — before readSyncMessage, before the guard, before any
      // applyUpdate. A reset reseeds at the fixed SEED_CLIENT_ID, so a client
      // that missed the reset (it was offline; FRAME_RESET is a broadcast)
      // holds structs at coordinates the live lineage now occupies. Answering
      // its step1 is enough to corrupt: encodeStateAsUpdate(doc, staleSV)
      // omits exactly the structs it "already has" and ships the full delete
      // set, so both ends silently diverge.
      if (frame.generation === '') {
        // '' means "I hold no server state for this doc". Always fine for a
        // read. For a WRITE it is only safe when there is nothing to collide
        // with — the client-created-row flow populates a doc at bind time,
        // before any inbound frame has taught it a generation.
        const serverIsEmpty = Y.encodeStateVector(doc).byteLength === 1
        if (messageType !== SYNC_STEP_1 && !serverIsEmpty) {
          sendReset(ws, frame.docId, 'stale')
          return
        }
      } else if (frame.generation !== generation) {
        console.warn(
          `[collab] stale generation for ${frame.docId} from ${ws.data.userId}`,
        )
        sendReset(ws, frame.docId, 'stale')
        return
      }

      // Partial writers (canWrite but not every site capability) pass each
      // update through the category guard BEFORE it touches the
      // authoritative doc — the same structure/content/style rules the HTTP
      // save enforces. Both non-step1 message types (step2 replies and
      // updates) carry `varUint8Array update` after the type varUint, so one
      // extraction covers whatever a hand-crafted client might send.
      if (messageType !== SYNC_STEP_1 && !ws.data.fullSiteWriter) {
        const guardDecoder = decoding.createDecoder(frame.payload)
        decoding.readVarUint(guardDecoder)
        const update = decoding.readVarUint8Array(guardDecoder)
        const verdict = validateGuardedUpdate(frame.docId, doc, update, ws.data.capabilities)
        if (!verdict.ok) {
          console.warn(`[collab] rejected ${frame.docId} update from ${ws.data.userId}: ${verdict.reason}`)
          // The sender's local doc holds the forbidden change — a TARGETED
          // reset makes their client rebind and reseed from the server,
          // reverting it everywhere (including their own screen).
          sendReset(ws, frame.docId, 'refused')
          return
        }
        Y.applyUpdate(doc, update, ws)
        return
      }

      const decoder = decoding.createDecoder(frame.payload)
      const encoder = encoding.createEncoder()
      syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
      if (encoding.length(encoder) > 0) {
        ws.send(encodeCollabFrame(frame.docId, generation, FRAME_SYNC, encoding.toUint8Array(encoder)))
      }
  }

  const handlers: WebSocketHandler<CollabSocketData> = {
    // Transport-level ceiling — the per-frame-type caps in `message` are the
    // fine-grained guards; this stops oversized frames before they buffer.
    maxPayloadLength: MAX_SYNC_PAYLOAD_BYTES + 1024,

    open(ws: ServerWebSocket<CollabSocketData>) {
      ws.subscribe(docTopic(PRESENCE_DOC_ID))
      // Late joiners need the current presence roster.
      const known = [...awareness.getStates().keys()]
      if (known.length > 0) {
        const update = awarenessProtocol.encodeAwarenessUpdate(awareness, known)
        ws.send(encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_AWARENESS, update))
      }
    },

    async message(ws: ServerWebSocket<CollabSocketData>, raw: string | Buffer) {
      if (typeof raw === 'string') return // binary protocol only
      let frame: CollabFrame | null = null
      try {
        frame = decodeCollabFrame(new Uint8Array(raw))
        await dispatchFrame(ws, frame)
      } catch (err) {
        console.error('[collab] socket message handler failed:', err)
        // A sync-write frame whose guard/apply threw left the sender's local
        // doc diverged from the authoritative one — reset it so their client
        // rebinds and reseeds. Awareness/malformed frames just get dropped.
        if (frame && frame.frameType === FRAME_SYNC && parseCollabDocId(frame.docId)) {
          try {
            sendReset(ws, frame.docId, 'refused')
          } catch (_sendErr) {
            // Socket already closing — nothing to recover.
          }
        }
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
          encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_AWARENESS, update),
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
