/**
 * `cms.rateLimit.take` — a sliding-window counter a plugin keeps for its own
 * keys (a visitor's `ctx.ip`, an account, an API key). The counters live in
 * the plugin's `PluginRateLimitStore` (`../pluginRateLimit.ts`).
 *
 * No permission: the counters are the plugin's own and live only in this
 * process, like `crypto.*`. They sit on the plugin's host record, so they go
 * when the plugin is unloaded, and a reload, an upgrade, a worker respawn or
 * a server restart starts every window again.
 */
import type { DbClient } from '../../../db/client'
import type { ApiCallFor } from '../../protocol/apiCallSchema'
import { replyApiOk } from '../apiReplies'
import type { HostPluginRecord } from '../types'

export async function handleRateLimitTake(
  msg: ApiCallFor<'cms.rateLimit.take'>,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [key, limit, windowMs] = msg.args
  replyApiOk(msg.pluginId, msg.correlationId, entry.rateLimits.take(key, limit, windowMs))
}
