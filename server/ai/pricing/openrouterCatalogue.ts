/**
 * Live model catalogue, sourced from OpenRouter's public `/api/v1/models`.
 *
 * OpenRouter is the only catalogue that publishes per-token list prices AND
 * context windows for Anthropic and OpenAI models (it resells them, so it has
 * to). The Anthropic and OpenAI model endpoints return sparse metadata and
 * never a price, so per-call cost can only be `tokens × list price` — and this
 * is where both the list price and the context window come from, live, with no
 * hand-maintained table.
 *
 * The endpoint is public (no key required). We keep only `anthropic/*` and
 * `openai/*` entries — those are the two providers whose own APIs omit price +
 * context. OpenRouter turns carry their own native USD cost and the OpenRouter
 * driver reads context windows straight from its own catalogue fetch; Ollama is
 * free and self-hosted. So neither needs an entry here.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'

const OPENROUTER_MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models'

/** Per-million-token prices for one model. Cache fields are null when the
 *  catalogue doesn't price caching for that model (cost then falls back to the
 *  standard input rate for cached tokens). */
export interface TokenPrices {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok: number | null
  cacheWritePerMTok: number | null
}

/** One catalogue row: prices plus the model's max context window (the total
 *  input+output tokens it can hold). `contextWindow` is null when OpenRouter
 *  doesn't publish a `context_length` for the model. */
export interface ModelCatalogueEntry {
  prices: TokenPrices
  contextWindow: number | null
}

export type ModelCatalogue = Map<string, ModelCatalogueEntry>

/**
 * Normalise a model id into the key used to look up prices, so a provider's
 * native id (dated and dashed, e.g. `claude-opus-4-8-20260514`) and the
 * OpenRouter slug (prefixed and dotted, e.g. `anthropic/claude-opus-4.8`)
 * collapse to the same key (`claude-opus-4-8`).
 *
 *   - drop a leading `anthropic/` | `openai/` | `openrouter/` | `orcarouter/`
 *     provider prefix
 *   - strip a trailing date suffix (`-YYYY-MM-DD` or `-YYYYMMDD`)
 *   - fold dots to dashes (OpenRouter writes `4.8`, providers write `4-8`)
 *
 * Variant suffixes that denote a genuinely different SKU (`:thinking`,
 * `-fast`) are deliberately preserved — they must not collide with the base
 * model, which carries different pricing.
 */
export function pricingKey(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^(anthropic|openai|openrouter|orcarouter)\//, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/\./g, '-')
}

const OpenRouterPricingSchema = Type.Object(
  {
    prompt: Type.Optional(Type.String()),
    completion: Type.Optional(Type.String()),
    input_cache_read: Type.Optional(Type.String()),
    input_cache_write: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

const OpenRouterModelSchema = Type.Object(
  {
    id: Type.String(),
    pricing: Type.Optional(OpenRouterPricingSchema),
    context_length: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

const OpenRouterModelsResponseSchema = Type.Object(
  { data: Type.Array(OpenRouterModelSchema) },
  { additionalProperties: true },
)

/** Per-token USD string → per-million-token number. Returns null for an
 *  absent/blank/non-finite value so the cost path can fall back cleanly. */
function perMTok(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const perToken = Number(value)
  if (!Number.isFinite(perToken)) return null
  return perToken * 1_000_000
}

/**
 * Fetch and normalise the OpenRouter catalogue into a `pricingKey → entry`
 * map covering Anthropic + OpenAI models. Throws on a failed request or an
 * unparseable body — the caller decides whether to fall back to the DB cache.
 */
export async function fetchOpenRouterCatalogue(): Promise<ModelCatalogue> {
  const res = await fetch(OPENROUTER_MODELS_ENDPOINT)
  if (!res.ok) {
    throw new Error(`[ai/pricing] catalogue request failed: ${res.status} ${res.statusText}`)
  }

  // Validate the external API body at the boundary (no `as` cast).
  const parsed = parseValue(OpenRouterModelsResponseSchema, await res.json())

  const catalogue: ModelCatalogue = new Map()
  for (const model of parsed.data) {
    if (!/^(anthropic|openai)\//.test(model.id)) continue
    const input = perMTok(model.pricing?.prompt)
    const output = perMTok(model.pricing?.completion)
    // A model with no input/output price is useless for costing — skip it.
    if (input === null || output === null) continue
    catalogue.set(pricingKey(model.id), {
      prices: {
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: perMTok(model.pricing?.input_cache_read),
        cacheWritePerMTok: perMTok(model.pricing?.input_cache_write),
      },
      contextWindow:
        model.context_length && Number.isFinite(model.context_length)
          ? model.context_length
          : null,
    })
  }
  return catalogue
}
