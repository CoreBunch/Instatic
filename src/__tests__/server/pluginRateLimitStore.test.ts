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

  it('evicts the least recently used counter with room when a shape is full, and says so', () => {
    const store = new PluginRateLimitStore(2)
    store.take('a', 5, W, T0)
    store.take('b', 5, W, T0)
    store.take('a', 5, W, T0) // a is now the most recently used
    expect(store.take('c', 5, W, T0)).toMatchObject({ ok: true, reason: 'capacity' })
    expect(store.size()).toBe(2)
    // b was forgotten (a fresh counter), a kept its two takes.
    expect(store.take('b', 5, W, T0)).toMatchObject({ ok: true, remaining: 4, reason: 'capacity' })
  })

  it('evicts a counter at its limit after every counter with room, in its own shape', () => {
    const store = new PluginRateLimitStore(10_000)
    for (let i = 0; i < 5; i++) store.take('busy', 5, W, T0)
    expect(store.take('busy', 5, W, T0).reason).toBe('limit')
    // One-take keys keep room (limit 5), so they are evicted first, however many come.
    for (let i = 0; i < 200_000; i++) store.take(`fresh-${i}`, 5, W, T0 + 1)
    expect(store.take('busy', 5, W, T0 + 2)).toMatchObject({ ok: false, reason: 'limit' })
  })

  it('is plain least recently used with limit 1, where every counter is at its limit', () => {
    const store = new PluginRateLimitStore(3)
    store.take('busy', 1, W, T0)
    expect(store.take('busy', 1, W, T0).reason).toBe('limit')
    // Three fresh keys fill and turn over the pool; the busy counter is forgotten.
    for (let i = 0; i < 3; i++) store.take(`fresh-${i}`, 1, W, T0 + 1)
    expect(store.take('busy', 1, W, T0 + 2)).toMatchObject({ ok: true, reason: 'capacity' })
  })

  it('forgets a counter kept one take short of its limit once enough fresh keys arrive', () => {
    const store = new PluginRateLimitStore(3)
    for (let i = 0; i < 4; i++) store.take('careful', 5, W, T0) // one short: still has room
    for (let i = 0; i < 3; i++) store.take(`fresh-${i}`, 5, W, T0 + 1)
    expect(store.take('careful', 5, W, T0 + 2)).toMatchObject({ ok: true, remaining: 4, reason: 'capacity' })
  })

  it('keeps a used-up counter through a flood of fresh keys in another shape', () => {
    const store = new PluginRateLimitStore(10_000)
    for (let i = 0; i < 3; i++) store.take('email:ada@example.com', 3, W, T0)
    for (let i = 0; i < 200_000; i++) store.take(`ip:${i}`, 100, W, T0 + 1)
    expect(store.take('email:ada@example.com', 3, W, T0 + 2)).toMatchObject({ ok: false, reason: 'limit' })
  })

  it('evicts a saturated counter only when every counter in the shape is saturated', () => {
    const store = new PluginRateLimitStore(2)
    store.take('a', 1, W, T0)
    store.take('b', 1, W, T0)
    // Both used up: the oldest one goes.
    expect(store.take('c', 1, W, T0)).toMatchObject({ ok: true, reason: 'capacity' })
    expect(store.take('b', 1, W, T0).reason).toBe('limit')
  })

  it('refuses a seventeenth limit and window pair with a clear error', () => {
    const store = new PluginRateLimitStore(10)
    for (let i = 1; i <= 16; i++) store.take('k', i, W, T0)
    expect(() => store.take('k', 17, W, T0)).toThrow(/at most 16 different limit and window pairs/)
    // The pairs already in use keep working.
    expect(store.take('k', 16, W, T0).ok).toBe(true)
  })

  it('drops counters whose windows have passed as it goes', () => {
    const store = new PluginRateLimitStore(1000)
    store.take('old-a', 5, W, T0)
    store.take('old-b', 5, W, T0)
    store.take('fresh', 5, W, T0 + 3 * W)
    expect(store.size()).toBe(1)
  })
})
