/**
 * Ollama driver — direct HTTP against an OpenAI-compatible local endpoint.
 *
 * Ollama speaks the OpenAI **chat/completions** wire protocol; the shared
 * `http/chatCompletions.ts` module owns the message mapping + SSE translation.
 * This file owns only Ollama-specific concerns: credential validation, live
 * model catalogue (`/api/tags`), and fallback models.
 *
 * Auth: `baseUrl` mode. The endpoint is the credential's `baseUrl`; an optional
 * stored API key is sent as a bearer (some Ollama deployments sit behind a
 * proxy that wants one). No cost is reported — `pricing.ts` prices any model
 * that has an entry; local models are free.
 *
 *   - stream():     POST `${baseUrl}/v1/chat/completions` with `stream: true`.
 *   - listModels(): GET `${baseUrl}/api/tags` (native Ollama catalogue).
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import {
  type AiAuthMode,
  type AiProviderId,
  type AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { makeChatCompletionsAdapter, trimSlash } from './http/chatCompletions'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['baseUrl']

// Ollama models vary per-install. Defaults are common picks as of May 2026 and
// only surface when the `/api/tags` catalogue fetch fails.
const FALLBACK_MODELS: AiProviderModel[] = [
  {
    id: 'llama4',
    label: 'Llama 4',
    tier: 'smart',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'llama3.3',
    label: 'Llama 3.3',
    tier: 'balanced',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
  },
  {
    id: 'qwen3',
    label: 'Qwen 3',
    tier: 'balanced',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
  },
]

export const ollamaDriver: AiProvider = {
  id: 'ollama' as AiProviderId,
  label: 'Ollama (local)',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(modelId: string) {
    const model = FALLBACK_MODELS.find((m) => m.id === modelId)
    return model?.capabilities ?? {
      toolCalling: true,
      visionInput: false,
      promptCache: false,
      streaming: true,
    }
  },

  async listModels(creds: AiResolvedCredential) {
    if (!creds.baseUrl) return FALLBACK_MODELS
    return fetchOllamaModels(creds.baseUrl)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'baseUrl' || !req.credentials.baseUrl) {
      // Defensive: a non-baseUrl credential reaching the driver implies a
      // mismatched DB row or a bypassed UI. Fail cleanly.
      yield {
        type: 'error',
        message:
          'Ollama requires a base URL. Add a base-URL credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(
      makeChatCompletionsAdapter({
        baseUrl: req.credentials.baseUrl,
        apiKey: req.credentials.apiKey,
        label: 'Ollama',
      }),
      req,
    )
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue (`/api/tags`)
// ---------------------------------------------------------------------------

const OllamaTagsSchema = Type.Object({
  models: Type.Optional(
    Type.Array(
      Type.Object({ name: Type.Optional(Type.String()), model: Type.Optional(Type.String()) }, { additionalProperties: true }),
    ),
  ),
})

async function fetchOllamaModels(baseUrl: string): Promise<AiProviderModel[]> {
  try {
    const res = await fetch(`${trimSlash(baseUrl)}/api/tags`)
    if (!res.ok) return FALLBACK_MODELS
    const parsed = parseValue(OllamaTagsSchema, await res.json())
    const models = (parsed.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((id) => ({
        id,
        label: id,
        catalogueSource: 'live' as const,
        capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
      }))
    return models.length > 0 ? models : FALLBACK_MODELS
  } catch (err) {
    console.error('[ai/ollama] models request failed:', err)
    return FALLBACK_MODELS
  }
}
