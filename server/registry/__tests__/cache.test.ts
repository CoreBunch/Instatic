import { describe, expect, it } from 'bun:test'
import { TtlCache } from '../cache'

describe('TtlCache', () => {
  it('serves within the TTL and expires after it', () => {
    let now = 1_000
    const cache = new TtlCache<string>(10, 500, () => now)
    cache.set('a', 'value')
    expect(cache.get('a')).toBe('value')
    now = 1_499
    expect(cache.get('a')).toBe('value')
    now = 1_500
    expect(cache.get('a')).toBeUndefined()
  })

  it('evicts the oldest entry past the cap, whether or not it was read', () => {
    const cache = new TtlCache<number>(2, 1_000, () => 0)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('sweeps every expired entry on insert, even ones that were read recently', () => {
    let now = 0
    const cache = new TtlCache<number>(100, 100, () => now)
    cache.set('old', 1)
    now = 50
    cache.set('mid', 2)
    expect(cache.get('old')).toBe(1)
    now = 160
    cache.set('new', 3)
    // Both earlier entries are past their TTL; a hit on `old` must not have
    // moved it behind a live entry where the sweep would skip it.
    expect(cache.get('old')).toBeUndefined()
    expect(cache.get('mid')).toBeUndefined()
    expect(cache.get('new')).toBe(3)
  })

  it('shares one in-flight load between concurrent misses', async () => {
    const cache = new TtlCache<string>(10, 1_000, () => 0)
    let loads = 0
    let release: (value: string) => void = () => {}
    const loader = () => {
      loads++
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }
    const first = cache.getOrLoad('k', loader)
    const second = cache.getOrLoad('k', loader)
    release('loaded')
    expect(await first).toBe('loaded')
    expect(await second).toBe('loaded')
    expect(loads).toBe(1)
    expect(cache.get('k')).toBe('loaded')
  })

  it('does not cache a failed load', async () => {
    const cache = new TtlCache<string>(10, 1_000, () => 0)
    await expect(cache.getOrLoad('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(cache.get('k')).toBeUndefined()
    expect(await cache.getOrLoad('k', () => Promise.resolve('ok'))).toBe('ok')
  })
})
