/**
 * OpenRouter driver — direct HTTP against the Responses API.
 *
 * Talks to `POST https://openrouter.ai/api/v1/responses` with no SDK. OpenRouter
 * exposes the OpenAI **Responses** wire protocol, so it shares the entire
 * mapping + SSE translation with the OpenAI driver via `responses-shared.ts`;
 * this file owns only the OpenRouter-specific transport and two extras:
 *
 *   - the live `/api/v1/models` catalogue fetch (`listModels`), TypeBox-validated
 *     at the boundary, so the picker reflects OpenRouter's 400+ models; and
 *   - native per-call USD cost: the shared translator passes `usage.cost`
 *     through as `costUsd`, so OpenRouter turns never need a `pricing.ts` entry.
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

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const OPENROUTER_ENDPOINT = `${OPENROUTER_BASE_URL}/responses`

// Capabilities are per-model and only knowable after `listModels()` has hit
// the catalog. The sync `capabilities()` accessor returns a permissive default
// (most OpenRouter models tool-call); the picker uses the richer per-model
// flags from `listModels()` when present.
const DEFAULT_CAPABILITIES: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

const openrouterAdapter = createResponsesAdapter({
  label: 'OpenRouter',
  endpoint: OPENROUTER_ENDPOINT,
  buildHeaders(req) {
    return {
      Authorization: `Bearer ${req.credentials.apiKey!}`,
      'content-type': 'application/json',
    }
  },
})

export const openrouterDriver: AiProvider = {
  id: 'openrouter' as AiProviderId,
  label: 'OpenRouter',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    return DEFAULT_CAPABILITIES
  },

  async resolveCapabilities(creds: AiResolvedCredential, modelId: string, signal: AbortSignal) {
    const models = await fetchOpenRouterModels(creds, signal)
    return models.find((model) => model.id === modelId)?.capabilities
      ?? DEFAULT_CAPABILITIES
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    return fetchOpenRouterModels(creds, signal)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      // Defensive: a non-apiKey credential reaching the driver implies a
      // mismatched DB row or a bypassed UI. Fail cleanly instead of POSTing
      // and getting a generic 401.
      yield {
        type: 'error',
        message:
          'OpenRouter requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(openrouterAdapter, req)
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue
// ---------------------------------------------------------------------------

const OpenRouterModelSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  architecture: Type.Optional(
    Type.Object({
      input_modalities: Type.Optional(Type.Array(Type.String())),
    }),
  ),
  supported_parameters: Type.Optional(Type.Array(Type.String())),
  context_length: Type.Optional(Type.Number()),
  pricing: Type.Optional(
    Type.Object(
      {
        prompt: Type.Optional(Type.String()),
        completion: Type.Optional(Type.String()),
      },
      { additionalProperties: true },
    ),
  ),
})

const OpenRouterModelsResponseSchema = Type.Object({
  data: Type.Array(OpenRouterModelSchema),
})

/** OpenRouter quotes prices per token as a decimal string; the picker shows
 *  per-million-token. Returns null for an absent/blank/non-finite value. */
function perMTok(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const perToken = Number(value)
  if (!Number.isFinite(perToken)) return null
  return perToken * 1_000_000
}

async function fetchOpenRouterModels(
  creds: AiResolvedCredential,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  const headers: Record<string, string> = {}
  // The catalogue endpoint is public, but sending the bearer lets per-key
  // availability (e.g. BYOK-only models) reflect in the list.
  if (creds.apiKey) headers.Authorization = `Bearer ${creds.apiKey}`

  const res = await fetch(`${OPENROUTER_BASE_URL}/models`, { headers, signal })
  if (!res.ok) {
    throw new Error(`[ai/openrouter] models request failed: ${res.status} ${res.statusText}`)
  }

  // Validate the external API body at the boundary (no `as` cast).
  const parsed = parseValue(OpenRouterModelsResponseSchema, await res.json())

  return parsed.data.map((model) => {
    const params = model.supported_parameters ?? null
    const modalities = model.architecture?.input_modalities ?? null
    // OpenRouter publishes prices + context windows inline, so the picker is
    // enriched straight from this fetch (Anthropic/OpenAI are enriched by the
    // models handler from the shared catalogue instead — their APIs omit both).
    const inputPerMTok = perMTok(model.pricing?.prompt)
    const outputPerMTok = perMTok(model.pricing?.completion)
    return {
      id: model.id,
      label: model.name ?? model.id,
      capabilities: {
        // When the catalogue declares parameters, honour the flag; when it
        // omits them, assume tool-calling (the common case for OpenRouter
        // chat models) rather than hiding the model from a tool-using scope.
        toolCalling: params ? params.includes('tools') : true,
        visionInput: modalities ? modalities.includes('image') : false,
        toolResultImages: false,
        promptCache: false,
        streaming: true,
      },
      ...(inputPerMTok !== null && outputPerMTok !== null
        ? { pricing: { inputPerMTok, outputPerMTok } }
        : {}),
      ...(model.context_length && Number.isFinite(model.context_length)
        ? { contextWindow: model.context_length }
        : {}),
    }
  })
}
