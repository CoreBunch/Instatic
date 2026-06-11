/**
 * Ollama driver — direct HTTP against an OpenAI-compatible local endpoint.
 *
 * Ollama speaks the OpenAI **chat/completions** wire protocol (NOT the
 * Responses protocol the OpenAI/OpenRouter drivers use), so it carries its own
 * message mapping + SSE translation here; the shared `http/` layer still owns
 * SSE framing, the multi-turn tool loop, tool execution, and error
 * classification.
 *
 * Auth: `baseUrl` mode. The endpoint is the credential's `baseUrl`; an optional
 * stored API key is sent as a bearer (some Ollama deployments sit behind a
 * proxy that wants one). No cost is reported — `pricing.ts` prices any model
 * that has an entry; local models are free.
 *
 *   - stream():     POST `${baseUrl}/v1/chat/completions` with `stream: true`.
 *   - listModels(): GET `${baseUrl}/api/tags` (native Ollama catalogue).
 */

import { Type, parseValue, type Static } from '@core/utils/typeboxHelpers'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AiAuthMode,
  type AiContentBlock,
  type AiMessage,
  type AiProviderId,
  type AiStreamEvent,
  type AiToolOutput,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import {
  runToolLoop,
  type ProviderAdapter,
  type TurnResult,
  type TurnToolCall,
  type TurnToolResult,
  type TurnTranslator,
  type TurnUsage,
} from './http/toolLoop'
import type { SseFrame } from './http/sse'
import { parseToolArguments } from './http/toolArgs'
import { nanoid } from 'nanoid'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['baseUrl']

// Ollama models vary per-install. Defaults are common picks as of May 2026 and
// only surface when the `/api/tags` catalogue fetch fails.
const FALLBACK_MODELS: AiProviderModel[] = [
  {
    id: 'llama4',
    label: 'Llama 4',
    tier: 'smart',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'llama3.3',
    label: 'Llama 3.3',
    tier: 'balanced',
    capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
  },
  {
    id: 'qwen3',
    label: 'Qwen 3',
    tier: 'balanced',
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
    yield* runToolLoop(makeOllamaAdapter(req.credentials.baseUrl, req.credentials.apiKey), req)
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
        capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
      }))
    return models.length > 0 ? models : FALLBACK_MODELS
  } catch (err) {
    console.error('[ai/ollama] models request failed:', err)
    return FALLBACK_MODELS
  }
}

// ---------------------------------------------------------------------------
// Provider-native chat/completions message shapes (request side)
// ---------------------------------------------------------------------------

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

// Each canonical `AiMessage` maps to one or more chat messages (an assistant
// turn carries text + tool_calls in one message, but several tool results fan
// out into several `role:'tool'` messages), so the loop's `TMessage` is a
// message *array* and the request body flattens before sending.
type ChatTurn = ChatMessage[]

// ---------------------------------------------------------------------------
// AiMessage[] → chat/completions messages[]
// ---------------------------------------------------------------------------

/**
 * Map the canonical log into chat/completions messages. The system prompt is
 * prepended as a `role:'system'` message (chat/completions has no separate
 * `instructions` field). Assistant `toolCall` blocks ride on the assistant
 * message as `tool_calls`; `role:'tool'` results become `role:'tool'` messages
 * paired by `tool_call_id`.
 */
export function mapChatHistory(systemPrompt: string[], messages: AiMessage[]): ChatTurn[] {
  const out: ChatTurn[] = []
  const system = joinSystemPrompt(systemPrompt)
  if (system) out.push([{ role: 'system', content: system }])

  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push([{ role: 'user', content: userContent(msg.content) }])
    } else if (msg.role === 'assistant') {
      out.push([assistantMessage(msg.content)])
    } else if (msg.role === 'tool') {
      out.push([{ role: 'tool', tool_call_id: msg.toolCallId, content: toolOutputToString(msg.output) }])
    }
    // role:'system' from the log is ignored — system is the prepended block.
  }
  return out
}

function joinSystemPrompt(systemPrompt: string[]): string {
  return systemPrompt.filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n')
}

function userContent(blocks: AiContentBlock[]): string | ChatContentPart[] {
  const hasImage = blocks.some((b) => b.kind === 'image')
  if (!hasImage) {
    return blocks
      .map((b) => (b.kind === 'text' ? b.text : ''))
      .filter((s) => s.length > 0)
      .join(' ')
  }
  const parts: ChatContentPart[] = []
  for (const block of blocks) {
    if (block.kind === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.kind === 'image') {
      // Base64 data URL — the OpenAI-compatible image_url part.
      parts.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
    }
  }
  return parts
}

function assistantMessage(blocks: AiContentBlock[]): ChatMessage {
  let text = ''
  const toolCalls: ChatToolCall[] = []
  for (const block of blocks) {
    if (block.kind === 'text') text += block.text
    else if (block.kind === 'toolCall') {
      toolCalls.push({
        id: block.toolCallId,
        type: 'function',
        function: { name: block.toolName, arguments: JSON.stringify(block.input ?? {}) },
      })
    }
  }
  return toolCalls.length > 0
    ? { role: 'assistant', content: text, tool_calls: toolCalls }
    : { role: 'assistant', content: text }
}

function toolOutputToString(output: AiToolOutput): string {
  if (!output.ok) return output.error ?? 'Tool call failed.'
  const text = JSON.stringify(output.data ?? { ok: true })
  // The OpenAI-compatible `role:'tool'` message is text-only — an image can't
  // ride in a tool result here. Drop it with a note so the model knows visual
  // evidence exists but wasn't delivered through this channel.
  if (output.images && output.images.length > 0) {
    return `${text}\n\n[${output.images.length} screenshot(s) omitted: this provider delivers tool results as text only.]`
  }
  return text
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function makeOllamaAdapter(baseUrl: string, apiKey: string | null): ProviderAdapter<ChatTurn> {
  return {
    label: 'Ollama',
    endpoint: `${trimSlash(baseUrl)}/v1/chat/completions`,

    buildHeaders() {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      // Optional bearer — some Ollama deployments sit behind an auth proxy.
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      return headers
    },

    mapHistory(req) {
      return mapChatHistory(req.systemPrompt, req.messages)
    },

    buildRequestBody(messages, req) {
      const body: Record<string, unknown> = {
        model: req.modelId,
        messages: messages.flat(),
        stream: true,
        // Ollama emits a final usage-only chunk when asked.
        stream_options: { include_usage: true },
      }
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            // TypeBox schema IS JSON Schema — pass it straight through.
            parameters: t.inputSchema,
          },
        }))
      }
      return body
    },

    buildToolResultMessage(results: TurnToolResult[]): ChatTurn {
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
}

// ---------------------------------------------------------------------------
// SSE event schema (boundary validation — no `as` on parsed JSON)
// ---------------------------------------------------------------------------

const ChatToolCallDeltaSchema = Type.Object(
  {
    index: Type.Optional(Type.Number()),
    id: Type.Optional(Type.String()),
    function: Type.Optional(
      Type.Object(
        { name: Type.Optional(Type.String()), arguments: Type.Optional(Type.String()) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const ChatChunkSchema = Type.Object(
  {
    choices: Type.Optional(
      Type.Array(
        Type.Object(
          {
            delta: Type.Optional(
              Type.Object(
                {
                  content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                  tool_calls: Type.Optional(Type.Array(ChatToolCallDeltaSchema)),
                },
                { additionalProperties: true },
              ),
            ),
            finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          },
          { additionalProperties: true },
        ),
      ),
    ),
    usage: Type.Optional(
      Type.Object(
        { prompt_tokens: Type.Optional(Type.Number()), completion_tokens: Type.Optional(Type.Number()) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// SSE translator — one per API call in the loop
// ---------------------------------------------------------------------------

interface MutableToolCall {
  id: string
  name: string
  arguments: string
}

export class ChatCompletionsTurnTranslator implements TurnTranslator<ChatTurn> {
  private text = ''
  // Tool calls accumulate by their streamed `index`; fragments arrive across
  // chunks (id + name on the first, arguments piecemeal after).
  private readonly toolsByIndex = new Map<number, MutableToolCall>()
  private readonly order: number[] = []
  private emitted = false
  private usage: TurnUsage | null = null

  translate(frame: SseFrame): AiStreamEvent[] {
    let chunk: Static<typeof ChatChunkSchema>
    try {
      chunk = parseValue(ChatChunkSchema, JSON.parse(frame.data))
    } catch {
      // Keep-alive / unparseable frame — not fatal.
      return []
    }

    if (chunk.usage) {
      this.usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      }
    }

    const choice = chunk.choices?.[0]
    if (!choice) return []

    const events: AiStreamEvent[] = []
    const delta = choice.delta
    if (delta) {
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        this.text += delta.content
        events.push({ type: 'text', text: delta.content })
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index ?? 0
          let acc = this.toolsByIndex.get(index)
          if (!acc) {
            acc = { id: tc.id ?? `tool-${nanoid()}`, name: '', arguments: '' }
            this.toolsByIndex.set(index, acc)
            this.order.push(index)
          }
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = tc.function.name
          if (typeof tc.function?.arguments === 'string') acc.arguments += tc.function.arguments
        }
      }
    }

    // The finish chunk signals all tool-call fragments are in; emit one
    // canonical toolCall event per accumulated call (we don't stream partial
    // arguments to the UI — see plan §11).
    if (choice.finish_reason && this.toolsByIndex.size > 0 && !this.emitted) {
      this.emitted = true
      for (const index of this.order) {
        const acc = this.toolsByIndex.get(index)!
        events.push({
          type: 'toolCall',
          toolCallId: acc.id,
          toolName: acc.name || 'tool',
          input: parseToolArguments(acc.arguments),
          status: 'pending',
        })
      }
    }

    return events
  }

  finish(): TurnResult<ChatTurn> {
    const toolCalls: TurnToolCall[] = []
    const chatToolCalls: ChatToolCall[] = []
    for (const index of this.order) {
      const acc = this.toolsByIndex.get(index)!
      toolCalls.push({ id: acc.id, name: acc.name || 'tool', input: parseToolArguments(acc.arguments) })
      chatToolCalls.push({
        id: acc.id,
        type: 'function',
        function: { name: acc.name || 'tool', arguments: acc.arguments || '{}' },
      })
    }

    const assistant: ChatMessage =
      chatToolCalls.length > 0
        ? { role: 'assistant', content: this.text, tool_calls: chatToolCalls }
        : { role: 'assistant', content: this.text }

    return {
      stop: toolCalls.length === 0,
      toolCalls,
      assistantMessage: this.text || chatToolCalls.length > 0 ? [assistant] : null,
      usage: this.usage,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

