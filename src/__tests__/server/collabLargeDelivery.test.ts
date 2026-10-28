import { describe, expect, it } from 'bun:test'
import * as encoding from 'lib0/encoding'
import { collabFramePackets, createCollabFrameReader, encodeCollabFrame, decodeCollabFrame, FRAME_SYNC } from '@core/collab'
import { createSocketFlow } from '../../../server/collab/socketFlow'

describe('large collaboration delivery', () => {
  it('delivers an 8 MiB stored snapshot over real sockets without exceeding default backpressure', async () => {
    const frame = encodeCollabFrame('site', 'generation', FRAME_SYNC, new Uint8Array(8 * 1024 * 1024).fill(37))
    let flow: ReturnType<typeof createSocketFlow> | undefined
    const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response('no upgrade', { status: 426 }) }, websocket: {
      closeOnBackpressureLimit: true,
      open(ws) { flow = createSocketFlow(ws); void flow.run(() => flow!.send(frame)) },
      drain() { flow?.drain() }, close() { flow?.close() }, message() {},
    } })
    const reader = createCollabFrameReader()
    const ws = new WebSocket(`ws://localhost:${server.port}`)
    ws.binaryType = 'arraybuffer'
    try {
      const received = await new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Snapshot delivery timed out')), 4000)
        ws.onclose = () => { clearTimeout(timer); reject(new Error('Socket closed before snapshot arrived')) }
        ws.onmessage = event => {
          const packet = new Uint8Array(event.data)
          expect(packet.byteLength).toBeLessThan(257 * 1024)
          const result = reader.read(packet)
          if (result) { clearTimeout(timer); resolve(result) }
        }
      })
      expect(received).toEqual(frame)
      expect(ws.readyState).toBe(WebSocket.OPEN)
    } finally { ws.close(); reader.clear(); server.stop(true) }
  })

  it('assembles interleaved documents and releases completed allocations', () => {
    const a = encodeCollabFrame('site', 'a', FRAME_SYNC, new Uint8Array(700000).fill(5))
    const b = encodeCollabFrame('page:x', 'b', FRAME_SYNC, new Uint8Array(700000).fill(9))
    const packetsA = [...collabFramePackets(a)], packetsB = [...collabFramePackets(b)]
    const reader = createCollabFrameReader(), results: Uint8Array[] = []
    for (let i = 0; i < packetsA.length; i++) for (const packet of [packetsA[i], packetsB[i]]) { const result = reader.read(packet); if (result) results.push(result) }
    expect(results).toEqual([a, b])
    expect(reader.read(encodeCollabFrame('presence', '', 4, new Uint8Array()))).not.toBeNull()
  })

  it('rejects missing, repeated, oversized and inconsistent fragments before applying a document', () => {
    const frame = encodeCollabFrame('site', 'a', FRAME_SYNC, new Uint8Array(700000))
    const packets = [...collabFramePackets(frame)]
    expect(() => createCollabFrameReader().read(packets[1])).toThrow('start')
    const reader = createCollabFrameReader()
    expect(reader.read(packets[0])).toBeNull()
    expect(() => reader.read(packets[0])).toThrow('order')
    reader.clear()
    expect(reader.read(packets[0])).toBeNull()
    const first = decodeCollabFrame(packets[0]), payload = encoding.createEncoder()
    encoding.writeVarUint(payload, 65 * 1024 * 1024); encoding.writeVarUint(payload, 0); encoding.writeUint8Array(payload, new Uint8Array([1]))
    expect(() => reader.read(encodeCollabFrame('', first.generation, 5, encoding.toUint8Array(payload)))).toThrow('fragment')
    // A different declared total is refused even when its offset is valid.
    const inconsistent = encoding.createEncoder()
    encoding.writeVarUint(inconsistent, frame.length + 1); encoding.writeVarUint(inconsistent, 256 * 1024); encoding.writeUint8Array(inconsistent, new Uint8Array(256 * 1024))
    expect(() => reader.read(encodeCollabFrame('', first.generation, 5, encoding.toUint8Array(inconsistent)))).toThrow('order')
  })
})
