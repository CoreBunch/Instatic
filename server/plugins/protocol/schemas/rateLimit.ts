/**
 * TypeBox schema for the `cms.rateLimit.take` api-call arguments: the
 * plugin's own key, how many takes it allows, and over how long.
 */
import { Type } from '@sinclair/typebox'

/** Most takes one window may allow. */
export const PLUGIN_RATE_LIMIT_MAX = 10_000
export const PLUGIN_RATE_LIMIT_MIN_WINDOW_MS = 1_000
export const PLUGIN_RATE_LIMIT_MAX_WINDOW_MS = 24 * 60 * 60 * 1000

export const RateLimitTakeArgsSchema = Type.Tuple([
  Type.String({ minLength: 1, maxLength: 200 }),
  Type.Integer({ minimum: 1, maximum: PLUGIN_RATE_LIMIT_MAX }),
  Type.Integer({ minimum: PLUGIN_RATE_LIMIT_MIN_WINDOW_MS, maximum: PLUGIN_RATE_LIMIT_MAX_WINDOW_MS }),
])
