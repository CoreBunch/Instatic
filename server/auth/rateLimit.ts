/**
 * Sliding-window rate limiter — in-memory, per-process.
 *
 * Used to throttle login attempts on `/admin/api/cms/login`. The bucket key is a
 * `(client-ip, email)` tuple so a single attacker IP can be slowed down even
 * across many target accounts, AND a single account can be defended against
 * across many attacker IPs.
 *
 * Storage is a `Map<key, number[]>` of attempt timestamps. Old entries fall
 * out of the window lazily on each access; `consume()` additionally runs an
 * opportunistic full prune — every `PRUNE_INTERVAL` calls, or as soon as the
 * map exceeds `PRUNE_SIZE_THRESHOLD` keys — so attacker-controlled
 * `(ip, email)` keys that go quiet cannot grow the map unbounded in a
 * long-lived process. The common path stays allocation-free: one counter
 * bump and a size check.
 *
 * Why in-memory instead of Redis or a DB table?
 *   - The CMS deploys as a single Bun process (the SQLite trade-off applies
 *     equally to PG-backed deployments — admin login is rare, single-writer).
 *   - No external dep, no extra container.
 *   - Counter loss on restart is acceptable: an attacker who waits for a
 *     restart still has to start over from scratch on the next attempt set.
 */

export interface RateLimitDecision {
  ok: boolean
  /** When `ok === false`, ms until the oldest in-window attempt expires. */
  retryAfterMs: number
  /** Remaining slots in the current window (0 when blocked). */
  remaining: number
}

interface Bucket {
  /** Attempt timestamps in ms-since-epoch, oldest first. */
  attempts: number[]
}

export interface RateLimiterOptions {
  /** Maximum allowed attempts per window. */
  limit: number
  /** Sliding window duration in milliseconds. */
  windowMs: number
}

export class RateLimiter {
  /** `consume()` calls between opportunistic prune sweeps. */
  static readonly PRUNE_INTERVAL = 1024
  /** Bucket count that forces a prune sweep on the next `consume()`. */
  static readonly PRUNE_SIZE_THRESHOLD = 4096

  private readonly buckets = new Map<string, Bucket>()
  private readonly options: RateLimiterOptions
  private callsSincePrune = 0

  constructor(options: RateLimiterOptions) {
    if (options.limit < 1) throw new Error('RateLimiter: limit must be >= 1')
    if (options.windowMs < 1) throw new Error('RateLimiter: windowMs must be >= 1')
    this.options = options
  }

  /**
   * Record an attempt against `key` and return whether it is allowed under
   * the current sliding window. Rejected attempts are NOT recorded
   * (sliding-window-log semantics): the window stays anchored to accepted
   * attempts, so a spamming client can neither grow its bucket unboundedly
   * nor push back the moment its oldest accepted attempt ages out.
   *
   * Pass `now` explicitly in tests; production callers omit it.
   */
  consume(key: string, now: number = Date.now()): RateLimitDecision {
    // Opportunistic housekeeping (see module header). Runs BEFORE the bucket
    // lookup so this call can never push onto a bucket the sweep just
    // deleted. Pruning only drops fully-aged-out attempts, which the
    // per-bucket filter below ignores anyway — limit decisions are unchanged.
    this.callsSincePrune += 1
    if (
      this.callsSincePrune >= RateLimiter.PRUNE_INTERVAL ||
      this.buckets.size > RateLimiter.PRUNE_SIZE_THRESHOLD
    ) {
      this.callsSincePrune = 0
      this.prune(now)
    }

    const { limit, windowMs } = this.options
    const cutoff = now - windowMs

    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { attempts: [] }
      this.buckets.set(key, bucket)
    }

    // Drop attempts that have aged out of the window.
    if (bucket.attempts.length > 0 && bucket.attempts[0]! <= cutoff) {
      bucket.attempts = bucket.attempts.filter((t) => t > cutoff)
    }

    if (bucket.attempts.length >= limit) {
      const oldest = bucket.attempts[0]!
      return {
        ok: false,
        retryAfterMs: oldest + windowMs - now,
        remaining: 0,
      }
    }

    bucket.attempts.push(now)
    return {
      ok: true,
      retryAfterMs: 0,
      remaining: limit - bucket.attempts.length,
    }
  }

  /** Reset the bucket for `key` — call on successful login to give the user a fresh quota. */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  /**
   * Drop empty / fully-aged-out buckets. Invoked opportunistically from
   * `consume()`; the per-call filter there already prevents stale data from
   * affecting decisions, so pruning only frees memory — it never changes a
   * limit decision.
   */
  prune(now: number = Date.now()): void {
    const cutoff = now - this.options.windowMs
    for (const [key, bucket] of this.buckets) {
      bucket.attempts = bucket.attempts.filter((t) => t > cutoff)
      if (bucket.attempts.length === 0) this.buckets.delete(key)
    }
  }

  /** Diagnostics — number of unique keys currently tracked. */
  size(): number {
    return this.buckets.size
  }
}

/**
 * Singleton rate limiter for the login endpoint.
 *
 * 5 attempts per 15-minute window per (ip, email) tuple. This blocks botnet
 * credential stuffing without burning legitimate users who fat-finger their
 * password a few times in a row.
 */
export const loginRateLimit = new RateLimiter({
  limit: 5,
  windowMs: 15 * 60 * 1000,
})

/**
 * Per-IP login rate limiter — blanket protection against a single attacker
 * IP grinding through many email addresses.
 *
 * 30 attempts per 10-minute window per IP. Triggers BEFORE per-(IP, email)
 * does, so a sustained credential-stuffing run from one IP gets shut off
 * while legitimate users (who only attempt their own account) never see it.
 *
 * IP-less requests (no proxy, Bun.serve doesn't surface client IP) bypass
 * this layer — the per-(IP, email) limiter still applies, with `'unknown'`
 * as the IP component, so a single email is still defended.
 */
export const loginPerIpRateLimit = new RateLimiter({
  limit: 30,
  windowMs: 10 * 60 * 1000,
})

/**
 * MFA verification limiter.
 *
 * Once the password has succeeded, a pending MFA session exists. TOTP codes
 * are only six digits, so the second-factor endpoint gets its own narrow
 * bucket. The key is the request IP when available, falling back to
 * `'unknown'` for local/dev requests.
 */
export const mfaRateLimit = new RateLimiter({
  limit: 10,
  windowMs: 10 * 60 * 1000,
})
