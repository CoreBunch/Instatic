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
})
