/**
 * The counters behind `api.cms.rateLimit.take`: one store per plugin, held on
 * its host record (`HostPluginRecord.rateLimits`), so they go when the plugin
 * is unloaded.
 *
 * Each (key, limit, window) is a two-bucket sliding-window counter: the count
 * of the current fixed window and of the one before it, with the previous
 * window weighted by how much of it still overlaps the sliding window. That
 * is a fixed few numbers per key whatever the limit, so memory is O(keys),
 * and a take is O(1).
 *
 * The store holds at most `maxKeys` keys. A take for a new key when it is
 * full forgets the least recently used key (a JS `Map` iterates in insertion
 * order, and every take moves its key to the end), so a flood of distinct
 * keys degrades the oldest counters instead of refusing new visitors. Every
 * so many takes the store also drops stale keys from the front, whose windows
 * have fully passed, so quiet keys do not linger until eviction.
 */

/** Keys one plugin's store holds before it forgets the least recently used. */
export const PLUGIN_RATE_LIMIT_KEYS = 10_000

export interface PluginRateLimitDecision {
  ok: boolean
  /** Takes left in the window after this one (0 when refused). */
  remaining: number
  /** When refused, ms until a take for this key would be allowed; 0 otherwise. */
  retryAfterMs: number
  /**
   * `limit`: refused, the key used up its limit. `capacity`: allowed, but
   * the store was full and forgot its least recently used key to make room.
   * Absent otherwise.
   */
  reason?: 'limit' | 'capacity'
}

interface Counter {
  limit: number
  windowMs: number
  /** Start of the current fixed window, a multiple of `windowMs`. */
  windowStart: number
  current: number
  previous: number
}

/**
 * Every `SWEEP_EVERY` takes, look at up to `SWEEP_LOOK` keys from the least
 * recently used end. Walking a `Map` from its start skips the slots earlier
 * deletes left behind, which costs microseconds on a large busy map, so the
 * walk runs on a slice of takes, never on each one.
 */
const SWEEP_EVERY = 256
const SWEEP_LOOK = 64

export class PluginRateLimitStore {
  private readonly counters = new Map<string, Counter>()
  private takesSinceSweep = 0

  private readonly maxKeys: number

  constructor(maxKeys: number) {
    this.maxKeys = maxKeys
  }

  take(key: string, limit: number, windowMs: number, now: number = Date.now()): PluginRateLimitDecision {
    if (++this.takesSinceSweep >= SWEEP_EVERY) {
      this.takesSinceSweep = 0
      this.sweep(now)
    }
    // The limit and window are part of the key: the same key under another
    // limit is another counter.
    const id = `${limit}/${windowMs}/${key}`
    let counter = this.counters.get(id)
    let evicted = false
    if (counter) {
      this.counters.delete(id)
    } else {
      if (this.counters.size >= this.maxKeys) {
        const oldest = this.counters.keys().next().value
        if (oldest !== undefined) this.counters.delete(oldest)
        evicted = true
      }
      counter = { limit, windowMs, windowStart: now - (now % windowMs), current: 0, previous: 0 }
    }
    this.counters.set(id, counter)
    roll(counter, now)

    const elapsed = now - counter.windowStart
    const estimate = counter.previous * ((windowMs - elapsed) / windowMs) + counter.current
    if (estimate + 1 > limit) {
      return { ok: false, remaining: 0, retryAfterMs: retryAfter(counter, now), reason: 'limit' }
    }
    counter.current += 1
    const remaining = Math.max(0, Math.floor(limit - estimate - 1))
    return evicted ? { ok: true, remaining, retryAfterMs: 0, reason: 'capacity' } : { ok: true, remaining, retryAfterMs: 0 }
  }

  /** Keys held right now. */
  size(): number {
    return this.counters.size
  }

  /** Drop keys at the least recently used end whose windows have fully passed. */
  private sweep(now: number): void {
    let looked = 0
    for (const [id, counter] of this.counters) {
      if (looked++ >= SWEEP_LOOK) return
      if (now - counter.windowStart < 2 * counter.windowMs) return
      this.counters.delete(id)
    }
  }
}

/** Move the counter's windows forward to the one `now` falls in. */
function roll(counter: Counter, now: number): void {
  const start = now - (now % counter.windowMs)
  if (start === counter.windowStart) return
  counter.previous = start - counter.windowStart === counter.windowMs ? counter.current : 0
  counter.current = 0
  counter.windowStart = start
}

/**
 * How long until the estimate leaves room for one more take. Within the
 * current window the previous window's weight falls linearly; if the current
 * window alone is full, the wait runs into the next window, where this
 * window's count is the one fading out.
 */
function retryAfter(counter: Counter, now: number): number {
  const { limit, windowMs, current, previous } = counter
  const elapsed = now - counter.windowStart
  const room = limit - 1 - current
  if (room >= 0 && previous > 0) {
    // previous * (windowMs - elapsed - t) / windowMs <= room
    const t = windowMs - elapsed - (room * windowMs) / previous
    if (t <= windowMs - elapsed) return Math.max(1, Math.ceil(t))
  }
  const toNextWindow = windowMs - elapsed
  // In the next window: current * (windowMs - t) / windowMs <= limit - 1
  const intoNext = current > limit - 1 ? windowMs - ((limit - 1) * windowMs) / current : 0
  return Math.max(1, Math.ceil(toNextWindow + intoNext))
}
