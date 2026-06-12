/**
 * Account lockout policy.
 *
 * The login handler applies two layers of brute-force defense:
 *
 *   1. Per-IP rate limit (in `rateLimit.ts`) — a single attacker IP cannot
 *      grind through many target accounts in a short window, regardless of
 *      whether each individual account is locked.
 *
 *   2. Per-account lockout (this module) — a single target account cannot
 *      be hammered from many IPs. After N consecutive failed logins, the
 *      account is temporarily locked for an exponentially growing window,
 *      capped at 24 h.
 *
 * Successful login resets the counter and clears `locked_until`. Pure
 * functions here; persistence is the caller's job (see `recordFailedLoginAttempt`
 * in `repositories/users.ts` and `markUserLoggedIn`).
 *
 * Why exponential backoff per consecutive lockout?
 *   A persistent attacker eventually loses interest as the wait grows from
 *   15 min → 30 → 60 → … → 24 h. A legitimate user who actually forgot their
 *   password completes a reset before the second lockout triggers. The
 *   doubling cap keeps the worst case bounded at 24 h, which gives an operator
 *   a sane window to respond to an alert without wedging an account forever.
 */

/** Failures-in-a-row before a lockout is applied. */
export const LOCKOUT_THRESHOLD = 5

/** First lockout duration (15 min). Doubles per additional lockout cycle. */
export const LOCKOUT_INITIAL_MS = 15 * 60 * 1000

/** Maximum lockout duration (24 h). */
export const LOCKOUT_CAP_MS = 24 * 60 * 60 * 1000

interface LockoutDecision {
  /** True when this failure crosses the threshold (caller should set locked_until). */
  triggered: boolean
  /** When `triggered`, the absolute time at which the lock expires. Null otherwise. */
  lockedUntil: Date | null
  /** Failure count after this attempt is recorded — for telemetry / audit. */
  failedLoginCount: number
}

interface LockState {
  locked: boolean
  /** When `locked`, milliseconds until `lockedUntil` (>= 0). */
  retryAfterMs: number
}

/**
 * Compute whether this failed attempt triggers a (new or extended) lockout.
 *
 * The policy is keyed off `failed_login_count`: every Nth failure (N =
 * LOCKOUT_THRESHOLD) triggers a fresh lock window. The window length doubles
 * with each cycle and is capped at LOCKOUT_CAP_MS.
 *
 * Examples (THRESHOLD = 5, INITIAL = 15min, CAP = 24h):
 *   failures 1–4   → no lock
 *   failures 5     → 15 min  (cycle 1)
 *   failures 6–9   → no lock change
 *   failures 10    → 30 min  (cycle 2)
 *   failures 15    → 60 min  (cycle 3)
 *   failures 20    → 120 min (cycle 4)
 *   …doubling…
 *   failures 40    → 1440 min = 24 h (cap reached)
 *   failures 45+   → 24 h (cap holds)
 *
 * `now` is injectable for deterministic tests.
 */
export function evaluateFailedAttempt(
  previousFailedLoginCount: number,
  now: Date = new Date(),
): LockoutDecision {
  const nextFailedLoginCount = previousFailedLoginCount + 1

  if (nextFailedLoginCount % LOCKOUT_THRESHOLD !== 0) {
    return {
      triggered: false,
      lockedUntil: null,
      failedLoginCount: nextFailedLoginCount,
    }
  }

  const cycle = Math.floor(nextFailedLoginCount / LOCKOUT_THRESHOLD) // 1, 2, 3, …
  const exponent = Math.max(0, cycle - 1)
  const proposedMs = LOCKOUT_INITIAL_MS * Math.pow(2, exponent)
  const durationMs = Math.min(proposedMs, LOCKOUT_CAP_MS)
  const lockedUntil = new Date(now.getTime() + durationMs)

  return {
    triggered: true,
    lockedUntil,
    failedLoginCount: nextFailedLoginCount,
  }
}

/**
 * Read-only check: is this user currently inside a lockout window?
 *
 * `lockedUntil` is the persisted ISO string (or null) from the user row.
 * Returns `{ locked: false, retryAfterMs: 0 }` when not locked or when the
 * window has already elapsed (the column is *not* auto-cleared until the
 * next successful login — that's fine; this check is the gate).
 */
export function evaluateLockState(
  lockedUntil: string | null,
  now: Date = new Date(),
): LockState {
  if (!lockedUntil) return { locked: false, retryAfterMs: 0 }
  const lockedUntilMs = Date.parse(lockedUntil)
  if (!Number.isFinite(lockedUntilMs)) return { locked: false, retryAfterMs: 0 }
  const retryAfterMs = lockedUntilMs - now.getTime()
  if (retryAfterMs <= 0) return { locked: false, retryAfterMs: 0 }
  return { locked: true, retryAfterMs }
}
