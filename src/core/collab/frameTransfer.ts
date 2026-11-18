/** Bounded server-to-client packets keep large stored documents below socket backpressure. */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { decodeCollabFrame, encodeCollabFrame } from './protocol'

const FRAGMENT = 5
const PACKET_BYTES = 256 * 1024
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
const MAX_TRANSFERS = 4
let transferSequence = 0

export function* collabFramePackets(frame: Uint8Array): Generator<Uint8Array> {
  if (frame.byteLength <= PACKET_BYTES) { yield frame; return }
  if (frame.byteLength > MAX_TRANSFER_BYTES) throw new Error('Collaboration document exceeds transfer limit')
  const id = String(++transferSequence)
  for (let offset = 0; offset < frame.byteLength; offset += PACKET_BYTES) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, frame.byteLength)
    encoding.writeVarUint(encoder, offset)
    encoding.writeUint8Array(encoder, frame.subarray(offset, offset + PACKET_BYTES))
    yield encodeCollabFrame('', id, FRAGMENT, encoding.toUint8Array(encoder))
  }
}

export function createCollabFrameReader() {
  const pending = new Map<string, { bytes: Uint8Array; offset: number }>()
  let allocated = 0
  return {
    read(packet: Uint8Array): Uint8Array | null {
      const frame = decodeCollabFrame(packet)
      if (frame.frameType !== FRAGMENT) return packet
      const decoder = decoding.createDecoder(frame.payload)
      const total = decoding.readVarUint(decoder)
      const offset = decoding.readVarUint(decoder)
      const chunk = decoding.readTailAsUint8Array(decoder)
      if (frame.docId !== '' || !frame.generation || !Number.isSafeInteger(total) || !Number.isSafeInteger(offset) || total <= PACKET_BYTES || total > MAX_TRANSFER_BYTES || !chunk.byteLength || chunk.byteLength > PACKET_BYTES || offset + chunk.byteLength > total) throw new Error('Invalid collaboration fragment')
      let transfer = pending.get(frame.generation)
      if (!transfer) {
        if (offset !== 0 || pending.size >= MAX_TRANSFERS || allocated + total > MAX_TRANSFER_BYTES) throw new Error('Invalid collaboration transfer start')
        transfer = { bytes: new Uint8Array(total), offset: 0 }
        pending.set(frame.generation, transfer)
        allocated += total
      }
      if (transfer.bytes.byteLength !== total || transfer.offset !== offset) throw new Error('Invalid collaboration fragment order')
      transfer.bytes.set(chunk, offset)
      transfer.offset += chunk.byteLength
      if (transfer.offset !== total) return null
      pending.delete(frame.generation)
      allocated -= total
      if (decodeCollabFrame(transfer.bytes).frameType === FRAGMENT) throw new Error('Nested collaboration fragments are invalid')
      return transfer.bytes
    },
    clear(): void { pending.clear(); allocated = 0 },
  }
}
