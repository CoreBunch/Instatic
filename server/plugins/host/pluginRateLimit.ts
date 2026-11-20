/**
 * The counters behind `api.cms.rateLimit.take`: one store per plugin, held on
 * its host record (`HostPluginRecord.rateLimits`), so they go when the plugin
 * is unloaded or its worker is respawned.
 *
 * This is an in-memory throttle, not a lockout. What it guarantees: bounded
 * memory and constant time per take, and at most `2 × limit − 1` takes in
 * any true sliding window for a counter that stays in memory. A counter does
 * not always stay: a plugin reload, upgrade, worker crash or server restart
 * drops every counter, and about `keysPerShape` fresh keys in one pool (one
 * IPv6 /48 rotated through as `ipKey` is enough) push any counter out. So a
 * defence that must hold (an account that may not be guessed at) belongs in
 * the plugin's own records.
 *
 * Each (key, limit, window) is a two-bucket sliding-window counter: the count
 * of the current fixed window and of the one before it, with the previous
 * window weighted by how much of it the sliding window still covers. That is
 * a few numbers per key whatever the limit, so memory is O(keys). The
 * estimate admits at most `2 × limit − 1` takes in any true sliding window,
 * and can refuse for up to `window ÷ limit` while the true count is low.
 *
 * Capacity is per (limit, window) shape, at most `MAX_SHAPES` shapes per
 * plugin (shapes come from plugin code, not from visitors), and at most
 * `keysPerShape` keys in each. Each shape keeps two least-recently-used
 * lists: counters with room, and saturated ones (refused, or at the limit).
 * A new key in a full shape evicts the oldest counter with room, and a
 * saturated one only when none has room. That makes a counter at its limit
 * the last to go, which is all it does: with `limit` 1 every counter is
 * saturated and eviction is plain least-recently-used, and a caller who stops
 * one take short of the limit stays among the counters with room. Every step
 * (look up, touch, move between lists, evict, sweep) is constant time: the
 * lists are linked, and the map is only ever read by key.
 */

/** Different (limit, window) pairs one plugin may use. */
const PLUGIN_RATE_LIMIT_SHAPES = 16
/** Keys one shape holds before it evicts. */
const PLUGIN_RATE_LIMIT_KEYS = 10_000

/** Stale counters dropped from the head of each list per take, at most. */
const SWEEP_PER_TAKE = 2

export interface PluginRateLimitDecision {
  ok: boolean
  /** Takes left in the window after this one (0 when refused). */
  remaining: number
  /** When refused, ms until a take for this key would be allowed; 0 otherwise. */
  retryAfterMs: number
  /**
   * `limit`: refused, the key used up its limit. `capacity`: allowed, but its
   * shape was full and forgot another counter to make room. Absent otherwise.
   */
  reason?: 'limit' | 'capacity'
}

interface Counter {
  key: string
  /** Start of the current fixed window, a multiple of the shape's window. */
  windowStart: number
  current: number
  previous: number
  saturated: boolean
  prev: Counter | null
  next: Counter | null
}

/** A doubly linked list, least recently used at the head. */
class CounterList {
  head: Counter | null = null
  tail: Counter | null = null
  size = 0

  push(counter: Counter): void {
    counter.prev = this.tail
    counter.next = null
    if (this.tail) this.tail.next = counter
    else this.head = counter
    this.tail = counter
    this.size += 1
  }

  remove(counter: Counter): void {
    if (counter.prev) counter.prev.next = counter.next
    else this.head = counter.next
    if (counter.next) counter.next.prev = counter.prev
    else this.tail = counter.prev
    counter.prev = null
    counter.next = null
    this.size -= 1
  }
}

/** Every counter of one (limit, window) pair. */
class Shape {
  private readonly byKey = new Map<string, Counter>()
  private readonly open = new CounterList()
  private readonly saturated = new CounterList()
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxKeys: number

  constructor(limit: number, windowMs: number, maxKeys: number) {
    this.limit = limit
    this.windowMs = windowMs
    this.maxKeys = maxKeys
  }

  take(key: string, now: number): PluginRateLimitDecision {
    this.sweep(now)
    const { limit, windowMs } = this
    let counter = this.byKey.get(key)
    let evicted = false
    if (counter) {
      this.listOf(counter).remove(counter)
    } else {
      if (this.byKey.size >= this.maxKeys) evicted = this.evict()
      counter = { key, windowStart: now - (now % windowMs), current: 0, previous: 0, saturated: false, prev: null, next: null }
      this.byKey.set(key, counter)
    }
    roll(counter, windowMs, now)

    const elapsed = now - counter.windowStart
    const estimate = counter.previous * ((windowMs - elapsed) / windowMs) + counter.current
    let decision: PluginRateLimitDecision
    if (estimate + 1 > limit) {
      counter.saturated = true
      decision = { ok: false, remaining: 0, retryAfterMs: retryAfter(counter, limit, windowMs, now), reason: 'limit' }
    } else {
      counter.current += 1
      const remaining = Math.max(0, Math.floor(limit - estimate - 1))
      counter.saturated = remaining === 0
      decision = evicted ? { ok: true, remaining, retryAfterMs: 0, reason: 'capacity' } : { ok: true, remaining, retryAfterMs: 0 }
    }
    this.listOf(counter).push(counter)
    return decision
  }

  size(): number {
    return this.byKey.size
  }

  private listOf(counter: Counter): CounterList {
    return counter.saturated ? this.saturated : this.open
  }

  /** Forget the oldest counter with room, or the oldest saturated one when none has room. */
  private evict(): boolean {
    const victim = this.open.head ?? this.saturated.head
    if (!victim) return false
    this.listOf(victim).remove(victim)
    this.byKey.delete(victim.key)
    return true
  }

  /**
   * Drop counters whose windows have both passed, from the head of each list.
   * In one shape every counter has the same window and a list is ordered by
   * last use, which is also the order of their windows, so the first live
   * head means the rest of that list is live too.
   */
  private sweep(now: number): void {
    for (const list of [this.open, this.saturated]) {
      for (let i = 0; i < SWEEP_PER_TAKE; i++) {
        const head = list.head
        if (!head || now - head.windowStart < 2 * this.windowMs) break
        list.remove(head)
        this.byKey.delete(head.key)
      }
    }
  }
}

export class PluginRateLimitStore {
  private readonly shapes = new Map<string, Shape>()
  private readonly keysPerShape: number

  constructor(keysPerShape: number = PLUGIN_RATE_LIMIT_KEYS) {
    this.keysPerShape = keysPerShape
  }

  take(key: string, limit: number, windowMs: number, now: number = Date.now()): PluginRateLimitDecision {
    const id = `${limit}/${windowMs}`
    let shape = this.shapes.get(id)
    if (!shape) {
      if (this.shapes.size >= PLUGIN_RATE_LIMIT_SHAPES) {
        throw new Error(
          `A plugin can use at most ${PLUGIN_RATE_LIMIT_SHAPES} different limit and window pairs; ` +
            `this would be pair ${PLUGIN_RATE_LIMIT_SHAPES + 1} (${limit} per ${windowMs} ms)`,
        )
      }
      shape = new Shape(limit, windowMs, this.keysPerShape)
      this.shapes.set(id, shape)
    }
    return shape.take(key, now)
  }

  /** Keys held right now, across every shape. */
  size(): number {
    let total = 0
    for (const shape of this.shapes.values()) total += shape.size()
    return total
  }
}

/** Move the counter's windows forward to the one `now` falls in. */
function roll(counter: Counter, windowMs: number, now: number): void {
  const start = now - (now % windowMs)
  if (start === counter.windowStart) return
  counter.previous = start - counter.windowStart === windowMs ? counter.current : 0
  counter.current = 0
  counter.windowStart = start
}

/**
 * How long until the estimate leaves room for one more take. Within the
 * current window the previous window's weight falls linearly; if the current
 * window alone is full, the wait runs into the next window, where this
 * window's count is the one fading out.
 */
function retryAfter(counter: Counter, limit: number, windowMs: number, now: number): number {
  const { current, previous } = counter
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
