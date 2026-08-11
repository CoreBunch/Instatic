/**
 * MiniMax driver — direct HTTP against the documented MiniMax API.
 *
 * The runtime reuses the shared OpenAI-compatible chat/completions transport
 * for MiniMax's text models, then overlays the provider-specific model
 * catalogue and request fields.
 */

import { isAbortError } from '@core/http'
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
import { makeAnthropicMessagesAdapter } from './anthropic'
import { makeChatCompletionsAdapter, normalizeOpenAiBaseUrl, trimSlash } from './http/chatCompletions'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['baseUrl']

const MINIMAX_MODELS: AiProviderModel[] = [
  {
    id: 'MiniMax-M3',
    label: 'MiniMax M3',
    capabilities: {
      toolCalling: true,
      visionInput: true,
      videoInput: true,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    },
    pricing: {
      inputPerMTok: 0.6,
      outputPerMTok: 2.4,
      cacheReadPerMTok: 0.12,
      cacheWritePerMTok: null,
    },
    contextWindow: 1_000_000,
    catalogueSource: 'live',
  },
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax M2.7',
    capabilities: {
      toolCalling: true,
      visionInput: false,
      videoInput: false,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    },
    pricing: {
      inputPerMTok: 0.3,
      outputPerMTok: 1.2,
      cacheReadPerMTok: 0.06,
      cacheWritePerMTok: 0.375,
    },
    contextWindow: 204_800,
    catalogueSource: 'live',
  },
]

const DEFAULT_CAPABILITIES: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  videoInput: false,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

function staticCapabilities(modelId: string): AiProviderCapabilities {
  if (modelId === 'MiniMax-M3') {
    return { ...DEFAULT_CAPABILITIES, visionInput: true, videoInput: true }
  }
  return { ...DEFAULT_CAPABILITIES }
}

function usesAnthropicProtocol(baseUrl: string): boolean {
  try {
    return /\/anthropic(?:\/v1)?\/?$/.test(new URL(baseUrl).pathname)
  } catch {
    return /\/anthropic(?:\/v1)?\/?$/.test(baseUrl)
  }
}

function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return trimSlash(baseUrl).replace(/\/v1$/, '')
}

function minimaxOpenAiAdapter(baseUrl: string, apiKey: string) {
  return makeChatCompletionsAdapter({
    baseUrl,
    apiKey,
    label: 'MiniMax',
    requestBodyExtras(req) {
      return req.modelId === 'MiniMax-M3'
        ? { reasoning_split: true, thinking: { type: 'adaptive' } }
        : { reasoning_split: true }
    },
  })
}

function minimaxAnthropicAdapter(baseUrl: string, apiKey: string) {
  return makeAnthropicMessagesAdapter({
    label: 'MiniMax',
    endpoint: `${normalizeAnthropicBaseUrl(baseUrl)}/v1/messages`,
    buildHeaders() {
      return {
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }
    },
  })
}

const ModelsResponseSchema = Type.Object(
  { data: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: true })) },
  { additionalProperties: true },
)

async function fetchMiniMaxModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  const anthropic = usesAnthropicProtocol(baseUrl)
  const endpoint = anthropic
    ? `${normalizeAnthropicBaseUrl(baseUrl)}/v1/models`
    : `${normalizeOpenAiBaseUrl(baseUrl)}/v1/models`
  const headers: Record<string, string> = anthropic
    ? { 'X-Api-Key': apiKey }
    : { Authorization: `Bearer ${apiKey}` }

  try {
    const res = await fetch(endpoint, { headers, signal })
    if (!res.ok) return []
    const parsed = parseValue(ModelsResponseSchema, await res.json())
    const liveIds = new Set(parsed.data.map((model) => model.id))
    return MINIMAX_MODELS.filter((model) => liveIds.has(model.id))
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw err
    console.error('[ai/minimax] models request failed:', err)
    return []
  }
}

export const minimaxDriver: AiProvider = {
  id: 'minimax' as AiProviderId,
  label: 'MiniMax',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(modelId: string) {
    return staticCapabilities(modelId)
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    if (creds.authMode !== 'baseUrl' || !creds.baseUrl || !creds.apiKey) return []
    return fetchMiniMaxModels(creds.baseUrl, creds.apiKey, signal)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (
      req.credentials.authMode !== 'baseUrl'
      || !req.credentials.baseUrl
      || !req.credentials.apiKey
    ) {
      yield {
        type: 'error',
        message:
          'MiniMax requires a base URL and API key. Add the credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    if (usesAnthropicProtocol(req.credentials.baseUrl)) {
      yield* runToolLoop(
        minimaxAnthropicAdapter(req.credentials.baseUrl, req.credentials.apiKey),
        req,
      )
      return
    }
    yield* runToolLoop(
      minimaxOpenAiAdapter(req.credentials.baseUrl, req.credentials.apiKey),
      req,
    )
  },
}
