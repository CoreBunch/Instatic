/**
 * Per-turn USD cost, priced from live OpenRouter list prices.
 *
 * The provider APIs split into two camps:
 *   - OpenRouter reports a native per-call USD cost; the driver passes it
 *     through and the persister uses it verbatim — this module is never asked.
 *   - Anthropic, OpenAI and Ollama report only token counts. Anthropic/OpenAI
 *     are priced here from the live catalogue; Ollama is self-hosted (free).
 *
 * Catalogue lifecycle:
 *   - cold start: load the DB cache (durable fallback) and kick a background
 *     refresh, so the first turn prices immediately off the last-known data;
 *   - with no DB cache yet: block once on a live fetch;
 *   - thereafter: serve from memory, refreshing in the background past the TTL.
 * A failed refresh is logged and keeps the previous data — never fatal.
 */

import type { DbClient } from '../../db/client'
import type { AiProviderId } from '../runtime/types'
import {
  fetchOpenRouterCatalogue,
  pricingKey,
  type ModelCatalogue,
  type TokenPrices,
} from './openrouterCatalogue'
import { loadCachedCatalogue, saveCachedCatalogue } from './store'

export { pricingKey } from './openrouterCatalogue'
export type { TokenPrices } from './openrouterCatalogue'

/** Token breakdown for one usage event, as the driver reported it. */
interface UsageTokens {
  /** Provider-native `input_tokens`. For Anthropic this EXCLUDES the cache
   *  buckets; for OpenAI it INCLUDES cached tokens as a subset. */
  promptTokens: number
  completionTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

const REFRESH_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

let memo: { catalogue: ModelCatalogue; refreshedAt: number } | null = null
let inflight: Promise<ModelCatalogue | null> | null = null

/**
 * USD cost for one usage event. Returns 0 when the model isn't in the live
 * catalogue (token counts are still persisted, so a later refresh can't
 * retroactively price it, but the meter stays honest about "unknown") or when
 * the provider is free (Ollama).
 */
export async function resolveCostUsd(
  db: DbClient,
  providerId: AiProviderId,
  modelId: string,
  usage: UsageTokens,
): Promise<number> {
  if (providerId === 'ollama') return 0

  const catalogue = await ensureCatalogue(db)
  const entry = catalogue.get(pricingKey(modelId))
  if (!entry) {
    console.warn(`[ai/pricing] no live price for ${providerId}/${modelId} — recording cost 0`)
    return 0
  }
  return computeCostUsd(entry.prices, providerId, usage)
}

/**
 * The live model catalogue (prices + context windows), keyed by `pricingKey`.
 * Used by the models endpoint to enrich the picker for the providers whose own
 * APIs omit price + context (Anthropic, OpenAI) — the picker is the single
 * source of context windows, including for the composer meter. Never throws —
 * returns an empty map if nothing is cached and the live fetch fails.
 */
export async function getModelCatalogue(db: DbClient): Promise<ModelCatalogue> {
  return ensureCatalogue(db)
}

/**
 * Apply per-million-token prices to a usage event, honouring the two providers'
 * different token accounting:
 *   - Anthropic: `promptTokens` is already cache-free; cache read/write are
 *     separate buckets billed at their own rates.
 *   - OpenAI: `promptTokens` is the total input and `cacheReadTokens` is a
 *     subset of it, so the non-cached remainder is `prompt − cacheRead`; there
 *     is no cache-write bucket.
 * When the catalogue omits a cache rate, cached tokens fall back to the
 * standard input rate.
 */
export function computeCostUsd(
  prices: TokenPrices,
  providerId: AiProviderId,
  usage: UsageTokens,
): number {
  const regularInput =
    providerId === 'anthropic'
      ? usage.promptTokens
      : Math.max(0, usage.promptTokens - usage.cacheReadTokens)

  const cacheReadRate = prices.cacheReadPerMTok ?? prices.inputPerMTok
  const cacheWriteRate = prices.cacheWritePerMTok ?? prices.inputPerMTok

  const cost =
    (regularInput / 1_000_000) * prices.inputPerMTok +
    (usage.cacheReadTokens / 1_000_000) * cacheReadRate +
    (usage.cacheCreationTokens / 1_000_000) * cacheWriteRate +
    (usage.completionTokens / 1_000_000) * prices.outputPerMTok

  // Round to the storage column's precision (numeric(10, 6)).
  return Math.round(cost * 1_000_000) / 1_000_000
}

async function ensureCatalogue(db: DbClient): Promise<ModelCatalogue> {
  if (!memo) {
    // A read failure here (e.g. schema drift before migrations catch up) must
    // never crash a caller — the catalogue is best-effort enrichment. Fall
    // through to a live fetch, which doesn't touch the DB.
    let cached: ModelCatalogue | null = null
    try {
      cached = await loadCachedCatalogue(db)
    } catch (err) {
      console.error('[ai/pricing] reading cached catalogue failed:', err)
    }
    // refreshedAt 0 marks the DB copy as stale so the next check kicks a
    // background refresh — but the data is usable for this turn immediately.
    if (cached) memo = { catalogue: cached, refreshedAt: 0 }
  }

  const fresh = memo && Date.now() - memo.refreshedAt < REFRESH_TTL_MS
  if (memo && fresh) return memo.catalogue

  if (memo) {
    // Stale but present — refresh in the background, serve stale now.
    void refresh(db)
    return memo.catalogue
  }

  // Nothing cached anywhere — block on the first live fetch.
  const fetched = await refresh(db)
  return fetched ?? new Map()
}

function refresh(db: DbClient): Promise<ModelCatalogue | null> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const catalogue = await fetchOpenRouterCatalogue()
      memo = { catalogue, refreshedAt: Date.now() }
      await saveCachedCatalogue(db, catalogue)
      return catalogue
    } catch (err) {
      console.error('[ai/pricing] catalogue refresh failed:', err)
      // Keep whatever we had (stale memo, or nothing → unknown models cost 0).
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}
