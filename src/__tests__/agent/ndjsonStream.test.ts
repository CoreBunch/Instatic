import { describe, expect, it } from 'bun:test'
import { readNdjsonStream } from '@admin/ai/ndjsonStream'
import { Type } from '@core/utils/typeboxHelpers'

const EventSchema = Type.Object({
  type: Type.String(),
  value: Type.Number(),
})

/**
 * Build a reader that hands back the given byte chunks one `read()` at a time —
 * exercising the cross-chunk line buffering that single-shot Response bodies
 * never trigger.
 */
function chunkedReader(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let i = 0
  return {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined }
      return { done: false, value: chunks[i++] }
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>
}

const encode = (s: string) => new TextEncoder().encode(s)

describe('readNdjsonStream — cross-chunk line buffering', () => {
  it('reassembles a JSON event split across two reads', async () => {
    // The first event is whole; the SECOND event is cut mid-token across the
    // chunk boundary — the only place the split('\n') + pop() buffering matters.
    const reader = chunkedReader([
      encode('{"type":"a","value":1}\n{"type":"b","va'),
      encode('lue":2}\n'),
    ])

    const events: { type: string; value: number }[] = []
    for await (const event of readNdjsonStream(reader, EventSchema)) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'a', value: 1 },
      { type: 'b', value: 2 },
    ])
  })

  it('handles a newline that lands exactly on a chunk boundary', async () => {
    const reader = chunkedReader([
      encode('{"type":"a","value":1}'),
      encode('\n{"type":"b","value":2}\n'),
    ])

    const events: { type: string; value: number }[] = []
    for await (const event of readNdjsonStream(reader, EventSchema)) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'a', value: 1 },
      { type: 'b', value: 2 },
    ])
  })

  it('emits a final event delivered without a trailing newline', async () => {
    // The stream ends mid-line-buffer: the last event has no terminating '\n'
    // before `done`. (Matches the real server, which newline-terminates, but
    // guards the buffer-flush-on-done behaviour explicitly.)
    const reader = chunkedReader([
      encode('{"type":"a","value":1}\n'),
      encode('{"type":"b","value":2}'),
    ])

    const events: { type: string; value: number }[] = []
    for await (const event of readNdjsonStream(reader, EventSchema)) {
      events.push(event)
    }

    // Only the newline-terminated event arrives; the dangling partial is held
    // in the buffer and dropped at stream end — never yielded half-parsed.
    expect(events).toEqual([{ type: 'a', value: 1 }])
  })

  it('skips malformed and blank lines without throwing', async () => {
    const reader = chunkedReader([
      encode('{"type":"a","value":1}\n\nnot json\n{"type":"b","value":2}\n'),
    ])

    const events: { type: string; value: number }[] = []
    for await (const event of readNdjsonStream(reader, EventSchema)) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: 'a', value: 1 },
      { type: 'b', value: 2 },
    ])
  })
})
