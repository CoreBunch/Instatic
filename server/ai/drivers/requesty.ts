/**
 * Requesty driver — direct HTTP against the Responses API.
 *
 * Talks to `POST https://router.requesty.ai/v1/responses` with no SDK. Requesty
 * is an OpenAI-compatible LLM router that exposes the OpenAI **Responses** wire
 * protocol, so — exactly like the OpenRouter driver — it shares the entire
 * mapping + SSE translation with the OpenAI driver via `responses-shared.ts`;
 * this file owns only the Requesty-specific transport and one extra:
 *
 *   - the live `/v1/models` catalogue fetch (`listModels`), TypeBox-validated
 *     at the boundary, so the picker reflects Requesty's 500+ models.
 *
 * Unlike OpenRouter, Requesty does not echo a per-call `usage.cost`, so a
 * Requesty turn is priced by the shared cost path (`server/ai/pricing`) from
 * the live catalogue like Anthropic/OpenAI, keyed by the normalised model id.
 *
 * The `/v1/models` object shape differs from OpenRouter's: capabilities are
 * flat booleans (`supports_tool_calling`, `supports_vision`), the context
 * window is `context_window` (not `context_length`), and prices are per-token
 * floats (`input_price` / `output_price`) rather than nested decimal strings —
 * so the parser maps Requesty's real fields rather than copying OpenRouter's.
 *
 * Tools are sent with their canonical TypeBox `inputSchema` as the JSON Schema
 * `parameters` directly — no Zod bridge.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import type {
  AiAuthMode,
  AiProviderId,
  AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { createResponsesAdapter } from './responses-shared'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

const REQUESTY_BASE_URL = 'https://router.requesty.ai/v1'
const REQUESTY_ENDPOINT = `${REQUESTY_BASE_URL}/responses`

// Capabilities are per-model and only knowable after `listModels()` has hit
// the catalog. The sync `capabilities()` accessor returns a permissive default
// (most Requesty models tool-call); the picker uses the richer per-model
// flags from `listModels()` when present.
const DEFAULT_CAPABILITIES: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

const requestyAdapter = createResponsesAdapter({
  label: 'Requesty',
  endpoint: REQUESTY_ENDPOINT,
  buildHeaders(req) {
    return {
      Authorization: `Bearer ${req.credentials.apiKey!}`,
      'content-type': 'application/json',
    }
  },
})

export const requestyDriver: AiProvider = {
  id: 'requesty' as AiProviderId,
  label: 'Requesty',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    return DEFAULT_CAPABILITIES
  },

  async resolveCapabilities(creds: AiResolvedCredential, modelId: string, signal: AbortSignal) {
    const models = await fetchRequestyModels(creds, signal)
    return models.find((model) => model.id === modelId)?.capabilities
      ?? DEFAULT_CAPABILITIES
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    return fetchRequestyModels(creds, signal)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      // Defensive: a non-apiKey credential reaching the driver implies a
      // mismatched DB row or a bypassed UI. Fail cleanly instead of POSTing
      // and getting a generic 401.
      yield {
        type: 'error',
        message:
          'Requesty requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(requestyAdapter, req)
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue
// ---------------------------------------------------------------------------

// Requesty's `/v1/models` describes each model with flat capability booleans
// and per-token float prices — a different shape from OpenRouter's. Fields we
// don't consume are ignored (`additionalProperties: true`) so the parser stays
// tolerant of catalogue growth.
const RequestyModelSchema = Type.Object(
  {
    id: Type.String(),
    // `chat` models are the completion-capable ones; embeddings and other
    // endpoints also appear in the list and are filtered out below.
    api: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    context_window: Type.Optional(Type.Number()),
    supports_tool_calling: Type.Optional(Type.Boolean()),
    supports_vision: Type.Optional(Type.Boolean()),
    supports_caching: Type.Optional(Type.Boolean()),
    // USD per single token (e.g. 1.5e-7); the picker shows per-million.
    input_price: Type.Optional(Type.Number()),
    output_price: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

const RequestyModelsResponseSchema = Type.Object(
  { data: Type.Array(RequestyModelSchema) },
  { additionalProperties: true },
)

/** Requesty quotes prices per token as a number; the picker shows
 *  per-million-token. Returns null for an absent/non-finite value. */
function perMTok(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return value * 1_000_000
}

async function fetchRequestyModels(
  creds: AiResolvedCredential,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  const headers: Record<string, string> = {}
  // The catalogue endpoint is public, but sending the bearer lets per-key
  // availability (e.g. BYOK-only models) reflect in the list.
  if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`

  const res = await fetch(`${REQUESTY_BASE_URL}/models`, { headers, signal })
  if (!res.ok) {
    throw new Error(`[ai/requesty] models request failed: ${res.status} ${res.statusText}`)
  }

  // Validate the external API body at the boundary (no `as` cast).
  const parsed = parseValue(RequestyModelsResponseSchema, await res.json())

  // Keep the chat-completion models; drop embeddings and other endpoints.
  // A missing `api` field is treated as chat rather than hidden.
  const chatModels = parsed.data.filter(
    (model) => model.api === undefined || model.api === 'chat',
  )

  return chatModels.map((model): AiProviderModel => {
    // Requesty publishes prices + context windows inline, so the picker is
    // enriched straight from this fetch (Anthropic/OpenAI are enriched by the
    // models handler from the shared catalogue instead — their APIs omit both).
    const inputPerMTok = perMTok(model.input_price)
    const outputPerMTok = perMTok(model.output_price)
    return {
      id: model.id,
      label: model.description ?? model.id,
      capabilities: {
        // When the catalogue declares a flag, honour it; when it omits one,
        // assume tool-calling (the common case for Requesty chat models)
        // rather than hiding the model from a tool-using scope.
        toolCalling: model.supports_tool_calling ?? true,
        visionInput: model.supports_vision ?? false,
        toolResultImages: false,
        promptCache: model.supports_caching ?? false,
        streaming: true,
      },
      ...(inputPerMTok !== null && outputPerMTok !== null
        ? { pricing: { inputPerMTok, outputPerMTok } }
        : {}),
      ...(model.context_window && Number.isFinite(model.context_window)
        ? { contextWindow: model.context_window }
        : {}),
    }
  })
}
