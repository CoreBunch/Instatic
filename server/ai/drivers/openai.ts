/**
 * OpenAI driver — direct HTTP against the Responses API.
 *
 * Talks to `POST https://api.openai.com/v1/responses` with no SDK: the shared
 * `http/` layer owns SSE parsing, the multi-turn tool loop, tool execution, and
 * error classification; `responses-shared.ts` owns the OpenAI-Responses mapping
 * (request `input`, `AiMessage[] → input[]`, and the SSE→AiStreamEvent
 * translator), shared with the OpenRouter driver. This file owns only the
 * OpenAI-specific transport: endpoint, bearer auth, and the live model fetch.
 *
 * Model list: `GET /v1/models` is the only source — no static fallback. The
 * catch is that OpenAI's endpoint is sparse (just `id`, no display name, no
 * capabilities, no tier) and returns every model — embeddings, audio, image,
 * moderation — so {@link fetchOpenAiModels} filters to chat/reasoning families
 * and derives the label + tier heuristically from the id.
 *
 * Tools are sent with their canonical TypeBox `inputSchema` as the JSON Schema
 * `parameters` directly — no Zod bridge. `strict` is omitted (our schemas use
 * optionals, which strict mode forbids).
 *
 * OpenAI does not report per-call USD cost, so `usage.costUsd` is left
 * undefined and the persister prices the turn from `pricing.ts`.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import type {
  AiAuthMode,
  AiProviderId,
  AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { createResponsesAdapter } from './responses-shared'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const OPENAI_ENDPOINT = `${OPENAI_BASE_URL}/responses`
const OPENAI_MODELS_ENDPOINT = `${OPENAI_BASE_URL}/models`

const openaiAdapter = createResponsesAdapter({
  label: 'OpenAI',
  endpoint: OPENAI_ENDPOINT,
  buildHeaders(req) {
    return {
      Authorization: `Bearer ${req.credentials.apiKey!}`,
      'content-type': 'application/json',
    }
  },
  promptCacheKey(req) {
    const toolNames = req.tools.map((t) => t.name).sort().join(',')
    return `instatic:${req.toolContextBase.scope}:${stableHash(toolNames)}`
  },
})

export const openaiDriver: AiProvider = {
  id: 'openai' as AiProviderId,
  label: 'OpenAI',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    // OpenAI's catalogue reports no capability flags, so we can't key off the
    // model id. Current GPT/o-series chat models tool-call and accept user
    // images, so a permissive input default is correct; Responses tool outputs
    // remain text-only. (Prompt caching is automatic on OpenAI, not the Anthropic-style
    // cache_control prefix this flag controls, so it stays false.)
    return {
      toolCalling: true,
      visionInput: true,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    }
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    return fetchOpenAiModels(creds, signal)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      // Defensive: a non-apiKey credential reaching the driver implies a
      // mismatched DB row or a bypassed UI. Fail cleanly instead of POSTing
      // and getting a generic 401.
      yield {
        type: 'error',
        message:
          'OpenAI requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(openaiAdapter, req)
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue — GET /v1/models
// ---------------------------------------------------------------------------

// OpenAI's list endpoint returns only `{ id }` per model (plus `object`,
// `created`, `owned_by` we ignore) — no display name, capabilities, or tier.
const OpenAiModelSchema = Type.Object(
  { id: Type.String() },
  { additionalProperties: true },
)

const OpenAiModelsResponseSchema = Type.Object(
  { data: Type.Array(OpenAiModelSchema) },
  { additionalProperties: true },
)

// Tier badge → sort rank (lower = shown first). Mirrors the picker's ordering.
const TIER_RANK: Record<string, number> = { smartest: 0, smart: 1, balanced: 2, fast: 3, cheap: 4 }

function stableHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/**
 * Fetch the live model catalogue from `GET /v1/models`. This is the only
 * source — there is no static fallback:
 *   - no API key ⇒ empty list (the picker shows nothing until a credential is
 *     selected); and
 *   - a failed request or unparseable body throws so the caller surfaces it.
 *
 * The endpoint returns every model the key can see (embeddings, audio, image,
 * moderation, …) with no metadata, so we filter to the chat/reasoning families
 * and derive the label + tier from the id — heuristic, not authoritative.
 */
async function fetchOpenAiModels(
  creds: AiResolvedCredential,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  if (creds.authMode !== 'apiKey' || !creds.apiKey) return []

  const res = await fetch(OPENAI_MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
    signal,
  })
  if (!res.ok) {
    throw new Error(`[ai/openai] models request failed: ${res.status} ${res.statusText}`)
  }
  // Validate the external API body at the boundary (no `as` cast).
  const parsed = parseValue(OpenAiModelsResponseSchema, await res.json())

  return parsed.data
    .filter((m) => isChatModel(m.id))
    .map((m) => ({
      id: m.id,
      label: deriveLabel(m.id),
      tier: deriveTier(m.id),
      capabilities: {
        toolCalling: true,
        visionInput: true,
        toolResultImages: false,
        promptCache: false,
        streaming: true,
      },
    } satisfies AiProviderModel))
    .sort((a, b) => {
      const rank = (TIER_RANK[a.tier ?? ''] ?? 9) - (TIER_RANK[b.tier ?? ''] ?? 9)
      // Within a tier, newest-id-first (descending) so e.g. gpt-5.5 precedes gpt-4o.
      return rank !== 0 ? rank : b.id.localeCompare(a.id)
    })
}

/**
 * Keep only chat/reasoning models. Include the GPT and o-series families;
 * exclude the non-conversational model types the catalogue also returns
 * (embeddings, audio, realtime, image, transcription, moderation, search).
 */
function isChatModel(id: string): boolean {
  if (!/^(gpt-|chatgpt-|o[1-9])/.test(id)) return false
  const EXCLUDED = [
    'embedding', 'whisper', 'tts', 'audio', 'realtime', 'image',
    'transcribe', 'moderation', 'search', 'dall-e',
  ]
  return !EXCLUDED.some((kw) => id.includes(kw))
}

/** Prettify a model id into a picker label, e.g. `gpt-5.4-mini` → `GPT 5.4 Mini`. */
function deriveLabel(id: string): string {
  return id
    .split('-')
    .map((part) => {
      if (part === 'gpt') return 'GPT'
      if (part === 'chatgpt') return 'ChatGPT'
      if (/^o[1-9]/.test(part)) return part // o1, o3-… stay lowercase (OpenAI branding)
      if (/^\d/.test(part)) return part // version tokens like 5.4, 4o
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

/**
 * Derive a tier badge from the id. OpenAI ships no ranking, so this is a
 * keyword heuristic: `nano` → cheap, `mini` → fast, everything else (flagship
 * GPT + reasoning o-series) → smartest. It only drives the picker badge and
 * the auto-default's "top model" pick, so a coarse split is acceptable.
 */
function deriveTier(id: string): string {
  if (id.includes('nano')) return 'cheap'
  if (id.includes('mini')) return 'fast'
  return 'smartest'
}
