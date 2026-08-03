/**
 * MiniMax driver — direct HTTP against the documented MiniMax API.
 *
 * The runtime reuses the shared OpenAI-compatible chat/completions transport
 * for MiniMax's text models, then overlays the provider-specific model
 * catalogue and request fields.
 */

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
import { makeChatCompletionsAdapter } from './http/chatCompletions'
import { openaiCompatibleDriver } from './openaiCompatible'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['baseUrl']

const MINIMAX_MODELS: AiProviderModel[] = [
  {
    id: 'MiniMax-M3',
    label: 'MiniMax M3',
    capabilities: {
      toolCalling: true,
      visionInput: true,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    },
    pricing: { inputPerMTok: 0.6, outputPerMTok: 2.4 },
    contextWindow: 1_000_000,
    catalogueSource: 'live',
  },
  {
    id: 'MiniMax-M2.7',
    label: 'MiniMax M2.7',
    capabilities: {
      toolCalling: true,
      visionInput: false,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    },
    pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
    contextWindow: 204_800,
    catalogueSource: 'live',
  },
]

const DEFAULT_CAPABILITIES: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

function staticCapabilities(modelId: string): AiProviderCapabilities {
  if (modelId === 'MiniMax-M3') {
    return { ...DEFAULT_CAPABILITIES, visionInput: true }
  }
  return { ...DEFAULT_CAPABILITIES }
}

function minimaxAdapter(baseUrl: string, apiKey: string | null) {
  return makeChatCompletionsAdapter({
    baseUrl,
    apiKey,
    label: 'MiniMax',
    requestBodyExtras() {
      return {
        reasoning_split: true,
        thinking: { type: 'adaptive' },
      }
    },
  })
}

export const minimaxDriver: AiProvider = {
  id: 'minimax' as AiProviderId,
  label: 'MiniMax',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(modelId: string) {
    return staticCapabilities(modelId)
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    if (creds.authMode !== 'baseUrl' || !creds.baseUrl) return []
    const liveModels = await openaiCompatibleDriver.listModels(creds, signal)
    const liveIds = new Set(liveModels.map((model) => model.id))
    const models = MINIMAX_MODELS.filter((model) => liveIds.has(model.id))
    return models.length > 0 ? models : []
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'baseUrl' || !req.credentials.baseUrl) {
      yield {
        type: 'error',
        message:
          'MiniMax requires a base URL. Add a base-URL credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(minimaxAdapter(req.credentials.baseUrl, req.credentials.apiKey), req)
  },
}
