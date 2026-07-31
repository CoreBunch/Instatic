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
import { isAbortError } from '@core/http'
import {
  type AiAuthMode,
  type AiProviderId,
  type AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { makeChatCompletionsAdapter, trimSlash } from './http/chatCompletions'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['baseUrl']
const OLLAMA_CAPABILITY_LOOKUP_CONCURRENCY = 6

// Ollama models vary per-install. Defaults are common picks as of May 2026 and
// only surface when the `/api/tags` catalogue fetch fails.
const FALLBACK_MODELS: AiProviderModel[] = [
  {
    id: 'llama4',
    label: 'Llama 4',
    tier: 'smart',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: true, toolResultImages: false, promptCache: false, streaming: true },
  },
  {
    id: 'llama3.3',
    label: 'Llama 3.3',
    tier: 'balanced',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
  },
  {
    id: 'qwen3',
    label: 'Qwen 3',
    tier: 'balanced',
    catalogueSource: 'fallback',
    capabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
  },
]

export const ollamaDriver: AiProvider = {
  id: 'ollama' as AiProviderId,
  label: 'Ollama (local)',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(modelId: string) {
    return fallbackCapabilities(modelId)
  },

  async resolveCapabilities(creds: AiResolvedCredential, modelId: string, signal: AbortSignal) {
    const declared = await fetchOllamaDeclaredCapabilities(creds, modelId, signal)
    const fallback = fallbackCapabilities(modelId)
    if (!declared) return { ...fallback, visionInput: false }
    return {
      ...fallback,
      toolCalling: declared.includes('tools'),
      visionInput: declared.includes('vision'),
    }
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    if (!creds.baseUrl) return FALLBACK_MODELS
    return fetchOllamaModels(creds, signal)
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

const OllamaShowSchema = Type.Object(
  { capabilities: Type.Optional(Type.Array(Type.String())) },
  { additionalProperties: true },
)

function fallbackCapabilities(modelId: string): AiProviderCapabilities {
  const model = FALLBACK_MODELS.find((candidate) => candidate.id === modelId)
  return model?.capabilities ?? {
    toolCalling: true,
    visionInput: false,
    toolResultImages: false,
    promptCache: false,
    streaming: true,
  }
}

async function fetchOllamaModels(
  creds: AiResolvedCredential,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  const baseUrl = creds.baseUrl
  if (!baseUrl) return FALLBACK_MODELS
  try {
    const res = await fetch(`${trimSlash(baseUrl)}/api/tags`, {
      headers: ollamaHeaders(creds.apiKey),
      signal,
    })
    if (!res.ok) return FALLBACK_MODELS
    const parsed = parseValue(OllamaTagsSchema, await res.json())
    const modelIds = (parsed.models ?? [])
      .map((m) => m.name ?? m.model)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
    const models: AiProviderModel[] = []
    for (let offset = 0; offset < modelIds.length; offset += OLLAMA_CAPABILITY_LOOKUP_CONCURRENCY) {
      signal?.throwIfAborted()
      const batch = modelIds.slice(offset, offset + OLLAMA_CAPABILITY_LOOKUP_CONCURRENCY)
      const resolvedBatch = await Promise.all(batch.map(async (id) => {
        const declared = await fetchOllamaDeclaredCapabilities(creds, id, signal).catch((err) => {
          if (signal?.aborted || isAbortError(err)) throw err
          return null
        })
        return {
          id,
          label: id,
          catalogueSource: 'live' as const,
          capabilities: {
            toolCalling: declared ? declared.includes('tools') : true,
            visionInput: declared?.includes('vision') ?? false,
            toolResultImages: false,
            promptCache: false,
            streaming: true,
          },
        } satisfies AiProviderModel
      }))
      models.push(...resolvedBatch)
    }
    return models.length > 0 ? models : FALLBACK_MODELS
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw err
    console.error('[ai/ollama] models request failed:', err)
    return FALLBACK_MODELS
  }
}

async function fetchOllamaDeclaredCapabilities(
  creds: AiResolvedCredential,
  modelId: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (!creds.baseUrl) return null
  const res = await fetch(`${trimSlash(creds.baseUrl)}/api/show`, {
    method: 'POST',
    headers: ollamaHeaders(creds.apiKey, true),
    body: JSON.stringify({ model: modelId }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`[ai/ollama] model capability request failed: ${res.status} ${res.statusText}`)
  }
  const parsed = parseValue(OllamaShowSchema, await res.json())
  return parsed.capabilities ?? null
}

function ollamaHeaders(apiKey: string | null, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['content-type'] = 'application/json'
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  return headers
}
