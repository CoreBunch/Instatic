/**
 * OrcaRouter driver — direct HTTP against the OpenAI `/v1/chat/completions`
 * endpoint.
 *
 * OrcaRouter is an OpenAI-compatible gateway (https://api.orcarouter.ai/v1)
 * that fronts frontier models from many providers behind one key. It shares
 * the chat/completions machinery with the Custom Provider driver via
 * `http/chatCompletions.ts`; this file owns the fixed endpoint, apiKey auth,
 * and live model discovery (`GET /v1/models`).
 *
 * Model ids are the gateway's OpenRouter-style slugs (`openai/gpt-5.6-sol`,
 * `anthropic/claude-sonnet-5`, …); the shared pricing key normaliser strips
 * the provider prefix so OrcaRouter turns cost like their direct counterparts.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import { isAbortError } from '@core/http'
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

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1'

// Per-model capability flags are unknowable from the OpenAI-shaped `/v1/models`
// catalogue, so use the same generic defaults as the Custom Provider driver.
const GENERIC_CAPABILITIES: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  toolResultImages: false,
  promptCache: false,
  streaming: true,
}

export const orcarouterDriver: AiProvider = {
  id: 'orcarouter' as AiProviderId,
  label: 'OrcaRouter',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    return { ...GENERIC_CAPABILITIES }
  },

  async listModels(creds: AiResolvedCredential, signal?: AbortSignal) {
    if (creds.authMode !== 'apiKey' || !creds.apiKey) return []
    return fetchOrcaRouterModels(creds.apiKey, signal)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      yield {
        type: 'error',
        message:
          'OrcaRouter requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(
      makeChatCompletionsAdapter({
        baseUrl: ORCAROUTER_BASE_URL,
        apiKey: req.credentials.apiKey,
        label: 'OrcaRouter',
        headers: {
          'HTTP-Referer': 'https://github.com/CoreBunch/Instatic',
          'X-Title': 'Instatic',
        },
      }),
      req,
    )
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue — GET /v1/models (standard OpenAI list shape)
// ---------------------------------------------------------------------------

const ModelsResponseSchema = Type.Object(
  { data: Type.Array(Type.Object({ id: Type.String() }, { additionalProperties: true })) },
  { additionalProperties: true },
)

async function fetchOrcaRouterModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  try {
    const res = await fetch(`${ORCAROUTER_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
    if (!res.ok) return []
    const parsed = parseValue(ModelsResponseSchema, await res.json())
    return parsed.data.map((m) => ({
      id: m.id,
      label: m.id,
      catalogueSource: 'live' as const,
      capabilities: { ...GENERIC_CAPABILITIES },
    }))
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) throw err
    console.error('[ai/orcarouter] models request failed:', err)
    return []
  }
}
