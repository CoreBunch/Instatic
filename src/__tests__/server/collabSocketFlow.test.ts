import { describe, expect, it } from 'bun:test'
import { createSocketFlow } from '../../../server/collab/socketFlow'

describe('collab socket backpressure', () => {
  it('waits for drain before processing the next request without resending the queued frame', async () => {
    const sent: number[] = []
    const flow = createSocketFlow({ send: (data) => { sent.push(data[0]!); return sent.length === 1 ? -1 : 1 }, close: () => {} })
    const first = flow.run(() => flow.send(new Uint8Array([1])))
    const second = flow.run(() => flow.send(new Uint8Array([2])))
    await Promise.resolve()
    expect(sent).toEqual([1])
    flow.drain()
    await Promise.all([first, second])
    expect(sent).toEqual([1, 2])
  })

  it('settles queued work on disconnect without sending it to the closed socket', async () => {
    const sent: number[] = []
    const flow = createSocketFlow({ send: (data) => { sent.push(data[0]!); return -1 }, close: () => {} })
    const first = flow.run(() => flow.send(new Uint8Array([1])))
    const second = flow.run(() => flow.send(new Uint8Array([2])))
    await Promise.resolve()
    flow.close()
    await Promise.all([first, second])
    expect(sent).toEqual([1])
  })

  it('forces reconnect when Bun reports a dropped frame', async () => {
    let closed = 0
    let sends = 0
    const flow = createSocketFlow({ send: () => { sends++; return 0 }, close: () => { closed++ } })
    await flow.run(() => flow.send(new Uint8Array([1])))
    await flow.run(() => flow.send(new Uint8Array([2])))
    expect(closed).toBe(1)
    expect(sends).toBe(1)
  })

  it('rechecks authorization after drain before sending the rest of a snapshot', async () => {
    let allowed = true
    let sends = 0
    const firstPacket = Promise.withResolvers<void>()
    const flow = createSocketFlow({
      send: () => { sends++; firstPacket.resolve(); return -1 }, close: () => {},
    }, async () => allowed)
    const sending = flow.run(() => flow.send(new Uint8Array(512 * 1024)))
    await firstPacket.promise
    allowed = false
    flow.drain()
    await sending
    expect(sends).toBe(1)
  })

  it('rechecks queued broadcasts when they reach the front of the queue', async () => {
    let allowed = true
    const sent: number[] = []
    const started = Promise.withResolvers<void>()
    const flow = createSocketFlow({
      send: (frame) => { sent.push(frame[0]!); started.resolve(); return -1 }, close: () => {},
    }, async () => allowed)
    const first = flow.enqueue(new Uint8Array([1]))
    const second = flow.enqueue(new Uint8Array([2]))
    await started.promise
    allowed = false
    flow.drain()
    await Promise.all([first, second])
    expect(sent).toEqual([1])
  })

  it('disconnects a slow peer instead of keeping an unbounded broadcast backlog', async () => {
    let closeCode = 0
    let sends = 0
    const started = Promise.withResolvers<void>()
    const flow = createSocketFlow({
      send: () => { sends++; started.resolve(); return -1 },
      close: (code) => { closeCode = code },
    })
    const first = flow.enqueue(new Uint8Array(1024 * 1024))
    await started.promise
    await flow.enqueue(new Uint8Array(16 * 1024 * 1024))
    await first
    expect(closeCode).toBe(1011)
    expect(sends).toBe(1)
  })

})
