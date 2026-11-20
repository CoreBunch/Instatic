/**
 * The counters behind `api.cms.rateLimit.take`: the two-bucket sliding-window
 * estimate, the wait it reports, and what happens when the store is full.
 */
import { describe, expect, it } from 'bun:test'
import { PluginRateLimitStore } from '../../../server/plugins/host/pluginRateLimit'

const W = 60_000
// A moment that starts a fixed window, so the arithmetic below is exact.
const T0 = W * 1_000_000

describe('PluginRateLimitStore', () => {
  it('allows the limit within one window and refuses the next take, without counting it', () => {
    const store = new PluginRateLimitStore(100)
    for (let i = 0; i < 5; i++) expect(store.take('k', 5, W, T0 + i).ok).toBe(true)
    const refused = store.take('k', 5, W, T0 + 10)
    // The 5 fade out over the next window; at a fifth of it 4 still count.
    expect(refused).toEqual({ ok: false, remaining: 0, retryAfterMs: W - 10 + W / 5, reason: 'limit' })
    // Still refused: the refused take did not add to the count.
    expect(store.take('k', 5, W, T0 + 20).ok).toBe(false)
  })

  it('weights the previous window by how much of it the sliding window still covers', () => {
    const store = new PluginRateLimitStore(100)
    for (let i = 0; i < 10; i++) store.take('k', 10, W, T0 + i)
    // A quarter into the next window, 3/4 of the previous 10 still count: 7.5.
    expect(store.take('k', 10, W, T0 + W + W / 4)).toMatchObject({ ok: true, remaining: 1 })
    // 7.5 + 1 + 1 = 9.5 is fine, the next would make 10.5.
    expect(store.take('k', 10, W, T0 + W + W / 4).ok).toBe(true)
    const refused = store.take('k', 10, W, T0 + W + W / 4)
    expect(refused.ok).toBe(false)
    // previous 10 must fade to 7 (room for current 2 + 1): at 3/10 of the window.
    expect(refused.retryAfterMs).toBe(W * 0.3 - W / 4)
  })

  it('forgets a window two windows back', () => {
    const store = new PluginRateLimitStore(100)
    for (let i = 0; i < 3; i++) store.take('k', 3, W, T0)
    expect(store.take('k', 3, W, T0 + 2 * W).remaining).toBe(2)
  })

  it('forgets the least recently used key when full, and says so', () => {
    const store = new PluginRateLimitStore(2)
    store.take('a', 1, W, T0)
    store.take('b', 1, W, T0)
    store.take('a', 1, W, T0) // refused, but a is now the most recently used
    expect(store.take('c', 1, W, T0)).toMatchObject({ ok: true, reason: 'capacity' })
    expect(store.size()).toBe(2)
    // b was forgotten, a was kept.
    expect(store.take('b', 1, W, T0)).toMatchObject({ ok: true, reason: 'capacity' })
    expect(store.take('c', 1, W, T0).reason).toBe('limit')
  })

  it('drops quiet keys from the least recently used end as it goes', () => {
    const store = new PluginRateLimitStore(1000)
    for (let i = 0; i < 3; i++) store.take(`old-${i}`, 5, W, T0)
    // A sweep runs on a slice of takes; these all reuse one fresh key.
    for (let i = 0; i < 256; i++) store.take('fresh', 1000, W, T0 + 3 * W)
    expect(store.size()).toBe(1)
  })
})
