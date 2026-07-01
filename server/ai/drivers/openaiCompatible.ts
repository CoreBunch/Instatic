/**
 * Custom Provider driver — direct HTTP against any endpoint that speaks the
 * OpenAI `/v1/chat/completions` wire protocol (Groq, Together, DeepSeek,
 * Mistral, Fireworks, self-hosted vLLM / LM Studio, …).
 *
 * Auth: `baseUrl` mode. The endpoint is the credential's `baseUrl`; an optional
 * stored API key is sent as a bearer (hosted services need one; local servers
 * often don't). The chat/completions machinery is shared with the Ollama driver
 * via `http/chatCompletions.ts`; this file owns only model discovery
 * (`GET ${baseUrl}/v1/models`) and the generic capability defaults.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import type { AiAuthMode, AiStreamEvent } from '../runtime/types'
import type {
  AiProvider,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { makeChatCompletionsAdapter, normalizeOpenAiBaseUrl } from './http/chatCompletions'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['baseUrl']

const GENERIC_CAPABILITIES = {
  toolCalling: true,
  visionInput: false,
  promptCache: false,
  streaming: true,
} as const

export const openaiCompatibleDriver: AiProvider = {
  id: 'openai-compatible',
  label: 'Custom Provider',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    // Arbitrary endpoints report no per-model capability flags. Tool-calling
    // must default true — the site/content agents require it; picking a model
    // that lacks it is the operator's choice.
    return { ...GENERIC_CAPABILITIES }
  },

  async listModels(creds: AiResolvedCredential) {
    if (creds.authMode !== 'baseUrl' || !creds.baseUrl) return []
    return fetchOpenAiCompatibleModels(creds.baseUrl, creds.apiKey)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'baseUrl' || !req.credentials.baseUrl) {
      yield {
        type: 'error',
        message:
          'This provider requires a base URL. Add a base-URL credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(
      makeChatCompletionsAdapter({
        baseUrl: req.credentials.baseUrl,
        apiKey: req.credentials.apiKey,
        label: 'Custom Provider',
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

/**
 * Fetch the model catalogue from `GET ${baseUrl}/v1/models`. Unlike the OpenAI
 * driver we do NOT filter by family or derive tiers — the endpoint is arbitrary,
 * so the id is the label and capabilities are the generic defaults. Any failure
 * (offline, non-OK, unparseable) returns [] so the picker stays empty; the
 * credential Test button treats an empty live catalogue as a failed test.
 */
async function fetchOpenAiCompatibleModels(
  baseUrl: string,
  apiKey: string | null,
): Promise<AiProviderModel[]> {
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(`${normalizeOpenAiBaseUrl(baseUrl)}/v1/models`, { headers })
    if (!res.ok) return []
    const parsed = parseValue(ModelsResponseSchema, await res.json())
    return parsed.data.map((m) => ({
      id: m.id,
      label: m.id,
      catalogueSource: 'live' as const,
      capabilities: { ...GENERIC_CAPABILITIES },
    }))
  } catch (err) {
    console.error('[ai/openai-compatible] models request failed:', err)
    return []
  }
}
