/**
 * Leading + trailing throttle used by burst-prone callbacks (color-picker
 * drags). The first call fires immediately, a burst coalesces to its LATEST
 * arguments, and `flush` delivers a pending trailing call at once.
 */
import { describe, expect, it } from 'bun:test'
import { createTrailingThrottle } from '@ui/lib/trailingThrottle'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('createTrailingThrottle', () => {
  it('fires the first call immediately (single clicks stay instant)', () => {
    const calls: number[] = []
    const throttle = createTrailingThrottle((n: number) => calls.push(n), 50)
    throttle.call(1)
    expect(calls).toEqual([1])
  })

  it('coalesces a burst into one trailing fire with the latest arguments', async () => {
    const calls: number[] = []
    const throttle = createTrailingThrottle((n: number) => calls.push(n), 40)
    for (let i = 1; i <= 10; i++) throttle.call(i)
    expect(calls).toEqual([1])
    await sleep(80)
    expect(calls).toEqual([1, 10])
  })

  it('keeps a steady drag down to roughly one fire per window', async () => {
    const calls: number[] = []
    const throttle = createTrailingThrottle((n: number) => calls.push(n), 40)
    for (let i = 1; i <= 20; i++) {
      throttle.call(i)
      await sleep(10)
    }
    await sleep(80)
    // 20 calls over ~200ms with a 40ms window: about 5-7 fires, never 20.
    expect(calls.length).toBeGreaterThanOrEqual(3)
    expect(calls.length).toBeLessThanOrEqual(9)
    // The final value always lands.
    expect(calls[calls.length - 1]).toBe(20)
  })

  it('flush delivers a pending trailing call immediately', () => {
    const calls: number[] = []
    const throttle = createTrailingThrottle((n: number) => calls.push(n), 1000)
    throttle.call(1)
    throttle.call(2)
    expect(calls).toEqual([1])
    throttle.flush()
    expect(calls).toEqual([1, 2])
    // Nothing left pending afterwards.
    throttle.flush()
    expect(calls).toEqual([1, 2])
  })
})
