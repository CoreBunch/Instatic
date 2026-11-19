/**
 * Site notices on the collab wire: a frame that names what changed outside
 * the documents, so every open editor can fetch the new state.
 */
import { describe, expect, it } from 'bun:test'
import * as encoding from 'lib0/encoding'
import {
  decodeCollabFrame,
  decodeNotice,
  encodeCollabFrame,
  encodeNoticePayload,
  FRAME_NOTICE,
  PRESENCE_DOC_ID,
} from '@core/collab'

describe('site notices', () => {
  it('round-trips a notice through a frame', () => {
    const frame = decodeCollabFrame(
      encodeCollabFrame(PRESENCE_DOC_ID, '', FRAME_NOTICE, encodeNoticePayload('loop-sources')),
    )
    expect(frame.docId).toBe(PRESENCE_DOC_ID)
    expect(frame.frameType).toBe(FRAME_NOTICE)
    expect(decodeNotice(frame.payload)).toBe('loop-sources')
  })

  it('ignores a notice it does not know and a payload it cannot read', () => {
    const encoder = encoding.createEncoder()
    encoding.writeVarString(encoder, 'something-newer')
    expect(decodeNotice(encoding.toUint8Array(encoder))).toBeNull()
    expect(decodeNotice(new Uint8Array())).toBeNull()
    expect(decodeNotice(new Uint8Array([255, 255, 255]))).toBeNull()
  })
})
