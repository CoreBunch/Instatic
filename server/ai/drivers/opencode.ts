/**
 * OpenCode driver — direct HTTP against OpenCode Zen.
 *
 * Talks to `POST https://opencode.ai/zen/v1/chat/completions` with no SDK.
 * OpenCode Zen exposes an OpenAI-compatible chat/completions API, so this
 * driver reuses the same chat-completions mapping + SSE translator as Ollama.
 *
 * Tools are sent with their canonical TypeBox `inputSchema` as JSON Schema
 * parameters directly — no Zod bridge.
 */

import { Type, parseValue } from '@core/utils/typeboxHelpers'
import type {
  AiAuthMode,
  AiProviderId,
  AiStreamEvent,
  AiToolOutput,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderCapabilities,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop, type ProviderAdapter } from './http/toolLoop'
import {
  ChatCompletionsTurnTranslator,
  mapChatHistory,
  type ChatMessage,
} from './ollama'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
const OPENCODE_CHAT_ENDPOINT = `${OPENCODE_BASE_URL}/chat/completions`
const OPENCODE_MODELS_ENDPOINT = `${OPENCODE_BASE_URL}/models`

const DEFAULT_CAPABILITIES: AiProviderCapabilities = {
  toolCalling: true,
  visionInput: false,
  promptCache: false,
  streaming: true,
}

const OpenCodeModelSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
    capabilities: Type.Optional(
      Type.Object(
        {
          toolcall: Type.Optional(Type.Boolean()),
          input: Type.Optional(
            Type.Object({ image: Type.Optional(Type.Boolean()) }, { additionalProperties: true }),
          ),
        },
        { additionalProperties: true },
      ),
    ),
    limit: Type.Optional(
      Type.Object({ context: Type.Optional(Type.Number()) }, { additionalProperties: true }),
    ),
    cost: Type.Optional(
      Type.Object(
        { input: Type.Optional(Type.Number()), output: Type.Optional(Type.Number()) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const OpenCodeModelsResponseSchema = Type.Object({
  data: Type.Optional(Type.Array(OpenCodeModelSchema)),
})

const opencodeAdapter: ProviderAdapter<ChatMessage[]> = {
  label: 'OpenCode',
  endpoint: OPENCODE_CHAT_ENDPOINT,

  buildHeaders(req) {
    return {
      Authorization: `Bearer ${req.credentials.apiKey!}`,
      'content-type': 'application/json',
    }
  },

  mapHistory(req) {
    return mapChatHistory(req.systemPrompt, req.messages)
  },

  buildRequestBody(messages, req) {
    const body: Record<string, unknown> = {
      model: req.modelId,
      messages: messages.flat(),
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    }
    return body
  },

  buildToolResultMessage(results) {
    return results.map((r) => ({
      role: 'tool' as const,
      tool_call_id: r.id,
      content: toolOutputToString(r.output),
    }))
  },

  createTurnTranslator() {
    return new ChatCompletionsTurnTranslator()
  },
}

export const opencodeDriver: AiProvider = {
  id: 'opencode' as AiProviderId,
  label: 'OpenCode',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    return DEFAULT_CAPABILITIES
  },

  async listModels(creds: AiResolvedCredential) {
    if (creds.authMode !== 'apiKey' || !creds.apiKey) return []
    return fetchOpenCodeModels(creds)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      yield {
        type: 'error',
        message:
          'OpenCode requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(opencodeAdapter, req)
  },
}

async function fetchOpenCodeModels(creds: AiResolvedCredential): Promise<AiProviderModel[]> {
  const res = await fetch(OPENCODE_MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${creds.apiKey!}` },
  })
  if (!res.ok) {
    throw new Error(`[ai/opencode] models request failed: ${res.status} ${res.statusText}`)
  }

  const parsed = parseValue(OpenCodeModelsResponseSchema, await res.json())
  return (parsed.data ?? []).map((model) => {
    const caps = model.capabilities
    return {
      id: model.id,
      label: model.name ?? model.id,
      catalogueSource: 'live' as const,
      capabilities: {
        toolCalling: caps?.toolcall ?? true,
        visionInput: caps?.input?.image ?? false,
        promptCache: false,
        streaming: true,
      },
      ...(typeof model.cost?.input === 'number' && typeof model.cost?.output === 'number'
        ? { pricing: { inputPerMTok: model.cost.input, outputPerMTok: model.cost.output } }
        : {}),
      ...(typeof model.limit?.context === 'number' ? { contextWindow: model.limit.context } : {}),
    }
  })
}

function toolOutputToString(output: AiToolOutput): string {
  if (!output.ok) return output.error ?? 'Tool call failed.'
  const text = JSON.stringify(output.data ?? { ok: true })
  if (output.images && output.images.length > 0) {
    return `${text}\n\n[${output.images.length} screenshot(s) omitted: this provider delivers tool results as text only.]`
  }
  return text
}
