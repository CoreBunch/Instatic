/**
 * Collab wire protocol — binary frames multiplexing many docs over ONE
 * WebSocket (`SITE_SOCKET_PATH`). Shared verbatim by the server socket layer
 * and the client provider.
 *
 * frame := varString docId | varString generation | varUint frameType | rest payload
 *
 *   FRAME_SYNC      payload = a y-protocols/sync message (step1/step2/update)
 *   FRAME_AWARENESS payload = a y-protocols/awareness update
 *                   (docId is the fixed PRESENCE_DOC_ID — awareness is
 *                   site-wide; clients filter peers by their active doc)
 *   FRAME_RESET     payload = varString ResetReason — the server dropped this
 *                   doc's CRDT state; clients rebind and the doc reseeds
 *                   server-side
 *   FRAME_PING /    no payload — application-level liveness, under
 *   FRAME_PONG      PRESENCE_DOC_ID and never gated on capabilities
 *
 * `generation` identifies the doc's CRDT LINEAGE, and is the reason this
 * envelope exists. A reset deletes the blob and the server reseeds at the
 * FIXED `SEED_CLIENT_ID`, so generation N+1 occupies the identical
 * `(client 1, clock 0..K)` coordinates as generation N. A client that missed
 * the reset — it was offline, and FRAME_RESET is a topic broadcast — would
 * otherwise hand the server structs from a dead lineage at live coordinates,
 * which Yjs cannot detect and which corrupts published content. Stamping the
 * lineage in the ENVELOPE lets both sides refuse a cross-lineage frame before
 * any doc is touched.
 *
 * `''` means "I hold no server state for this doc yet": always safe for a
 * sync step1, and safe for a write only when the server's doc is still empty
 * (the client-created-row flow, which populates a doc at bind time before any
 * inbound frame). Presence and reset frames always use `''`.
 */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const SITE_SOCKET_PATH = '/admin/api/cms/site-socket'

/** The pseudo doc id awareness frames travel under. */
export const PRESENCE_DOC_ID = 'presence'

export const FRAME_SYNC = 0
export const FRAME_AWARENESS = 1
export const FRAME_RESET = 2
/**
 * Liveness. `readyState` alone cannot tell a live socket from a black-holed
 * one — on a VPN drop, captive portal, sleep/wake or mobile handover the
 * browser keeps the socket OPEN until the TCP retransmission timeout, which is
 * minutes. Since the editor refuses edits it cannot deliver, "connected" has
 * to mean "reachable", and only an application-level round trip can say so.
 */
export const FRAME_PING = 3
export const FRAME_PONG = 4

/**
 * Why the server dropped a doc.
 *
 *   rewritten — routine: the backing JSON was rewritten out-of-relay (a
 *               Settings save, a data-workspace edit, a plugin install).
 *               Nothing of the user's was lost; do not alarm them.
 *   stale     — this client's frame belonged to a dead lineage; whatever it
 *               held for that doc has been discarded.
 *   refused   — the write-policy guard rejected the update.
 *   oversize  — the frame exceeded the sync payload ceiling.
 *   gone      — the doc's branch no longer exists; do not rebind, leave the
 *               branch instead.
 */
export type ResetReason = 'rewritten' | 'stale' | 'refused' | 'oversize' | 'gone'

const RESET_REASONS: readonly ResetReason[] = ['rewritten', 'stale', 'refused', 'oversize', 'gone']

export interface CollabFrame {
  docId: string
  generation: string
  frameType: number
  payload: Uint8Array
}

export function encodeCollabFrame(
  docId: string,
  generation: string,
  frameType: number,
  payload: Uint8Array,
): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, docId)
  encoding.writeVarString(encoder, generation)
  encoding.writeVarUint(encoder, frameType)
  encoding.writeUint8Array(encoder, payload)
  return encoding.toUint8Array(encoder)
}

export function decodeCollabFrame(data: Uint8Array): CollabFrame {
  const decoder = decoding.createDecoder(data)
  const docId = decoding.readVarString(decoder)
  const generation = decoding.readVarString(decoder)
  const frameType = decoding.readVarUint(decoder)
  const payload = decoding.readTailAsUint8Array(decoder)
  return { docId, generation, frameType, payload }
}

export function encodeResetPayload(reason: ResetReason): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, reason)
  return encoding.toUint8Array(encoder)
}

/** Wire data — an unknown reason degrades to the routine one, never throws. */
export function decodeResetReason(payload: Uint8Array): ResetReason {
  if (payload.byteLength === 0) return 'rewritten'
  try {
    const value = decoding.readVarString(decoding.createDecoder(payload))
    return RESET_REASONS.includes(value as ResetReason) ? (value as ResetReason) : 'rewritten'
  } catch {
    // Undecodable payload — treat as the routine reseed rather than alarming.
    return 'rewritten'
  }
}
