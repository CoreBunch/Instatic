/**
 * Collab wire protocol — binary frames multiplexing many docs over ONE
 * WebSocket (`SITE_SOCKET_PATH`). Shared verbatim by the server socket layer
 * and the client provider.
 *
 * frame := varString docId | varUint frameType | rest payload
 *
 *   FRAME_SYNC      payload = a y-protocols/sync message (step1/step2/update)
 *   FRAME_AWARENESS payload = a y-protocols/awareness update
 *                   (docId is the fixed PRESENCE_DOC_ID — awareness is
 *                   site-wide; clients filter peers by their active doc)
 *   FRAME_RESET     no payload — the server dropped this doc's CRDT state
 *                   (its backing JSON was rewritten out-of-relay); clients
 *                   rebind and the doc reseeds server-side
 */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const SITE_SOCKET_PATH = '/admin/api/cms/site-socket'

/** The pseudo doc id awareness frames travel under. */
export const PRESENCE_DOC_ID = 'presence'

export const FRAME_SYNC = 0
export const FRAME_AWARENESS = 1
export const FRAME_RESET = 2

export interface CollabFrame {
  docId: string
  frameType: number
  payload: Uint8Array
}

export function encodeCollabFrame(
  docId: string,
  frameType: number,
  payload: Uint8Array,
): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, docId)
  encoding.writeVarUint(encoder, frameType)
  encoding.writeUint8Array(encoder, payload)
  return encoding.toUint8Array(encoder)
}

export function decodeCollabFrame(data: Uint8Array): CollabFrame {
  const decoder = decoding.createDecoder(data)
  const docId = decoding.readVarString(decoder)
  const frameType = decoding.readVarUint(decoder)
  const payload = decoding.readTailAsUint8Array(decoder)
  return { docId, frameType, payload }
}
