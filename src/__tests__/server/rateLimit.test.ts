import { describe, expect, it } from 'bun:test'
import { RateLimiter } from '../../../server/auth/rateLimit'

describe('RateLimiter', () => {
  it('allows attempts up to the limit, then rejects', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 1000 })

    expect(rl.consume('k', 0).ok).toBe(true)
    expect(rl.consume('k', 1).ok).toBe(true)
    expect(rl.consume('k', 2).ok).toBe(true)
    const blocked = rl.consume('k', 3)
    expect(blocked.ok).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('reports retryAfterMs based on the oldest in-window attempt', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 })

    rl.consume('k', 0)
    rl.consume('k', 100)
    const blocked = rl.consume('k', 200)
    expect(blocked.ok).toBe(false)
    // Oldest attempt was at t=0; window is 1000ms; now=200; retryAfter = 0 + 1000 - 200 = 800
    expect(blocked.retryAfterMs).toBe(800)
  })

  it('drops attempts that have aged out of the window', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 })

    rl.consume('k', 0)
    rl.consume('k', 500)
    expect(rl.consume('k', 600).ok).toBe(false) // blocked: 2 attempts within window

    // After t=1100, the attempt at t=0 has aged out, leaving only t=500 in
    // the window — one slot is free again.
    expect(rl.consume('k', 1100).ok).toBe(true)
  })

  it('keeps each key isolated', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 })

    expect(rl.consume('a', 0).ok).toBe(true)
    expect(rl.consume('a', 1).ok).toBe(false)
    // 'b' has its own bucket — not affected by 'a' being full.
    expect(rl.consume('b', 1).ok).toBe(true)
  })

  it('reset() clears the bucket so the next attempt is allowed', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 })

    rl.consume('k', 0)
    expect(rl.consume('k', 1).ok).toBe(false)
    rl.reset('k')
    expect(rl.consume('k', 2).ok).toBe(true)
  })

  it('rejected attempts do NOT extend the window (sliding-window-log semantics)', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 })

    rl.consume('k', 0)
    // Rejected attempts at t=100, 200, 300 do NOT get recorded — the window
    // is anchored to the original accepted attempt at t=0. This is the
    // standard sliding-window-log behavior; recording on rejection too
    // would let a spamming client grow the bucket unboundedly in memory.
    rl.consume('k', 100)
    rl.consume('k', 200)
    rl.consume('k', 300)
    // At t=999, the original attempt is still in window; still blocked.
    expect(rl.consume('k', 999).ok).toBe(false)
    // At t=1001, the original attempt has aged out → bucket is empty →
    // next attempt is allowed.
    expect(rl.consume('k', 1001).ok).toBe(true)
  })

  it('prune() drops entirely-expired buckets', () => {
    const rl = new RateLimiter({ limit: 5, windowMs: 1000 })
    rl.consume('a', 0)
    rl.consume('b', 0)
    expect(rl.size()).toBe(2)

    rl.prune(2000) // every attempt has aged out
    expect(rl.size()).toBe(0)
  })

  it('rejects malformed options', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow()
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow()
  })

  describe('opportunistic pruning via consume()', () => {
    it('sweeps aged-out buckets after PRUNE_INTERVAL calls', () => {
      const rl = new RateLimiter({ limit: 5, windowMs: 1000 })

      // 600 distinct keys at t=0 — below both prune triggers, all retained.
      for (let i = 0; i < 600; i++) rl.consume(`key-${i}`, 0)
      expect(rl.size()).toBe(600)

      // Advance past the window so every key-N bucket is fully aged out,
      // then drive the call counter to exactly PRUNE_INTERVAL on one fresh
      // key (rejected attempts still count as consume() calls).
      const later = 2000
      const remaining = RateLimiter.PRUNE_INTERVAL - 600
      for (let i = 0; i < remaining; i++) rl.consume('probe', later)

      // The sweep dropped all 600 stale buckets; only 'probe' (which holds
      // in-window attempts) survives.
      expect(rl.size()).toBe(1)
    })

    it('sweeps immediately once the map exceeds PRUNE_SIZE_THRESHOLD keys', () => {
      const rl = new RateLimiter({ limit: 5, windowMs: 1000 })

      const total = RateLimiter.PRUNE_SIZE_THRESHOLD + 1
      for (let i = 0; i < total; i++) rl.consume(`key-${i}`, 0)
      // Interval-triggered sweeps ran during the loop, but nothing had aged
      // out yet — every bucket is still tracked.
      expect(rl.size()).toBe(total)

      // One consume() past the window: the size trigger fires without
      // waiting for the call counter, dropping every aged-out bucket.
      rl.consume('fresh', 2000)
      expect(rl.size()).toBe(1)
    })

    it('never changes a limit decision — in-window attempts survive the sweep', () => {
      const rl = new RateLimiter({ limit: 1, windowMs: 10_000 })

      rl.consume('victim', 0)
      // Force an interval-triggered sweep mid-window with filler keys.
      for (let i = 0; i < RateLimiter.PRUNE_INTERVAL; i++) rl.consume(`filler-${i}`, 1)
      // The victim's accepted attempt is still in window, so it stays blocked.
      expect(rl.consume('victim', 2).ok).toBe(false)
    })
  })
})
