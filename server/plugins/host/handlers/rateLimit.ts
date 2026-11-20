/**
 * `cms.rateLimit.take` — a sliding-window counter a plugin keeps for its own
 * keys (a visitor's `ctx.ip`, an account, an API key), backed by core's
 * `RateLimiter`, the one sign-in limits use.
 *
 * No permission: the counters are the plugin's own and live only in this
 * process, like `crypto.*`. They sit on the plugin's host record, so they go
 * when the plugin is unloaded, and a reload, an upgrade or a server restart
 * starts every window again.
 *
 * Memory is bounded per plugin: at most `MAX_SHAPES` distinct
 * (limit, window) pairs, and at most `MAX_KEYS` live keys in each. A take for
 * a new key once a pair is full is refused (`ok: false`), so a flood of
 * distinct keys fails closed instead of growing the host's heap.
 */
import type { DbClient } from '../../../db/client'
import { RateLimiter } from '../../../auth/rateLimit'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

const MAX_SHAPES = 16
const MAX_KEYS = 10_000

export async function handleRateLimitTake(
  msg: ApiCallFor<'cms.rateLimit.take'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [key, limit, windowMs] = msg.args
  const shape = `${limit}/${windowMs}`
  let limiter = entry.rateLimiters.get(shape)
  if (!limiter) {
    if (entry.rateLimiters.size >= MAX_SHAPES) {
      throw new Error(`A plugin can use at most ${MAX_SHAPES} different limit and window pairs`)
    }
    limiter = new RateLimiter({ limit, windowMs })
    entry.rateLimiters.set(shape, limiter)
  }
  const now = Date.now()
  if (limiter.isUntouched(key, now) && limiter.size() >= MAX_KEYS) {
    limiter.prune(now)
    if (limiter.size() >= MAX_KEYS) {
      replyApiOk(msg.pluginId, msg.correlationId, { ok: false, remaining: 0, retryAfterMs: windowMs })
      return
    }
  }
  const decision = limiter.consume(key, now)
  replyApiOk(msg.pluginId, msg.correlationId, {
    ok: decision.ok,
    remaining: decision.remaining,
    retryAfterMs: decision.retryAfterMs,
  })
}
