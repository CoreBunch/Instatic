/**
 * Shared chat/completions adapter for OpenAI-compatible providers.
 *
 * Extracted from ollama.ts — all drivers using the OpenAI chat/completions
 * wire protocol share this module. The factory `makeChatCompletionsAdapter`
 * wires the per-provider options (baseUrl, apiKey, label) into the generic
 * adapter shape consumed by `runToolLoop`.
 */

import { Type, parseValue, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { stripTrailingSlashes } from '@core/utils/urlValidation'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AiContentBlock,
  type AiMessage,
  type AiStreamEvent,
  type AiToolOutput,
} from '../../runtime/types'
import {
  type ProviderAdapter,
  type TurnResult,
  type TurnToolCall,
  type TurnToolResult,
  type TurnTranslator,
  type TurnUsage,
} from './toolLoop'
import type { SseFrame } from './sse'
import { parseToolArguments } from './toolArgs'
import { nanoid } from 'nanoid'

// ---------------------------------------------------------------------------
// Provider-native chat/completions message shapes (request side)
// ---------------------------------------------------------------------------

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ChatToolCall = {
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
export type ChatTurn = ChatMessage[]

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
// Wire-level tool pairing repair
// ---------------------------------------------------------------------------

/**
 * Text sent back for a `tool_call_id` the history never answered. Strict
 * OpenAI-compatible gateways (DeepSeek above all) reject the whole request with
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'" when even one call is unanswered, which
 * makes the conversation permanently un-sendable.
 */
export const UNANSWERED_TOOL_CALL_RESULT =
  'Tool call was interrupted before it returned a result. Re-issue it if the work is still needed.'

/**
 * Enforce the two wire invariants every strict chat/completions gateway checks
 * on the final message array.
 *
 * 1. **Tool pairing.** `buildMessageHistory` heals the persisted history, but
 *    the in-flight loop can still hand us a broken run: an aborted turn pushes
 *    the assistant `tool_calls` message before its results (see `runToolLoop`'s
 *    abort returns), and a re-mapped history leaves stale indices behind.
 *    Healing here — the last boundary before `JSON.stringify` — means no caller
 *    can emit a request a strict provider rejects.
 * 2. **Role alternation.** DeepSeek answers two consecutive `user` (or
 *    `assistant`) messages with `400 does not support successive user or
 *    assistant messages`. History produces that shape on its own: a user who
 *    sends, aborts before the assistant row is written, then sends again leaves
 *    two adjacent `user` rows.
 *
 * Guarantees on return:
 * - every assistant `tool_calls` entry is answered by a `role:'tool'` message
 *   for that exact id, immediately after it;
 * - no `role:'tool'` message answers a call that was never declared;
 * - duplicate call ids within one assistant turn are collapsed (the second
 *   copy could never be answered twice);
 * - no two adjacent messages share a role.
 */
export function sanitizeToolPairing(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  // Ids declared by the current assistant run and not yet answered, in issue
  // order so synthetic results land where the model expects them.
  const pending = new Map<string, true>()

  const flushPending = (): void => {
    for (const id of pending.keys()) {
      out.push({ role: 'tool', tool_call_id: id, content: UNANSWERED_TOOL_CALL_RESULT })
    }
    pending.clear()
  }

  /** Push an assistant turn, absorbing a preceding text-only assistant turn. */
  const pushAssistant = (content: string, toolCalls: ChatToolCall[] | null): void => {
    const previous = out[out.length - 1]
    if (previous?.role === 'assistant' && !previous.tool_calls?.length) {
      const merged = joinText(previous.content, content)
      out[out.length - 1] = toolCalls
        ? { role: 'assistant', content: merged, tool_calls: toolCalls }
        : { role: 'assistant', content: merged }
      return
    }
    out.push(
      toolCalls ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content },
    )
  }

  for (const original of messages) {
    if (original.role === 'tool') {
      // Orphan result: nothing declared this id, so replaying it is a 400.
      if (!pending.has(original.tool_call_id)) continue
      pending.delete(original.tool_call_id)
      out.push(original)
      continue
    }

    // Any non-tool message closes the open assistant run.
    flushPending()

    if (original.role === 'system') {
      out.push(original)
      continue
    }

    if (original.role === 'assistant' && original.tool_calls && original.tool_calls.length > 0) {
      const seen = new Set<string>()
      const toolCalls: ChatToolCall[] = []
      for (const call of original.tool_calls) {
        if (!call.id || seen.has(call.id)) continue
        seen.add(call.id)
        toolCalls.push(call)
      }
      if (toolCalls.length === 0) {
        pushAssistant(original.content, null)
        continue
      }
      pushAssistant(original.content, toolCalls)
      for (const call of toolCalls) pending.set(call.id, true)
      continue
    }

    if (original.role === 'user') {
      const previous = out[out.length - 1]
      if (previous?.role === 'user') {
        out[out.length - 1] = { role: 'user', content: joinUserContent(previous.content, original.content) }
        continue
      }
      out.push(original)
      continue
    }

    pushAssistant(original.content, null)
  }

  flushPending()
  return out
}

function joinText(a: string, b: string): string {
  if (a.length === 0) return b
  if (b.length === 0) return a
  return `${a}\n\n${b}`
}

function joinUserContent(a: string | ChatContentPart[], b: string | ChatContentPart[]): string | ChatContentPart[] {
  if (typeof a === 'string' && typeof b === 'string') return joinText(a, b)
  const toParts = (content: string | ChatContentPart[]): ChatContentPart[] =>
    typeof content === 'string'
      ? content.length > 0
        ? [{ type: 'text', text: content }]
        : []
      : [...content]
  return [...toParts(a), ...toParts(b)]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function trimSlash(url: string): string {
  return stripTrailingSlashes(url)
}

/**
 * Normalize an OpenAI-style base URL: strip trailing slashes and an optional
 * trailing `/v1` segment, so both `https://x/openai` and `https://x/openai/v1`
 * resolve to the same endpoint when `/v1/...` is appended.
 *
 * This is a no-op for Ollama-style base URLs (e.g. `http://localhost:11434`)
 * that don't carry a trailing `/v1`.
 */
export function normalizeOpenAiBaseUrl(url: string): string {
  return trimSlash(url).replace(/\/v1$/, '')
}

// ---------------------------------------------------------------------------
// SSE event schema (boundary validation — no `as` on parsed JSON)
// ---------------------------------------------------------------------------

// Real OpenAI-compatible gateways (OpenCode Zen, OpenRouter, vLLM, …) routinely
// send explicit `null` for optional per-chunk fields (e.g. `usage: null`,
// `tool_calls: null`, `delta.content: null`) on every chunk rather than omitting
// them. `Type.Optional(T)` accepts absent-or-T but NOT null, so a stray null
// fails validation, the frame is dropped in `translate()`'s catch, and the
// model's entire reply silently vanishes ("no reply"). `nullable()` tolerates
// both an absent field and an explicit null.
const nullable = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]))

const ChatToolCallDeltaSchema = Type.Object(
  {
    index: nullable(Type.Number()),
    id: nullable(Type.String()),
    function: nullable(
      Type.Object(
        { name: nullable(Type.String()), arguments: nullable(Type.String()) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const ChatChunkSchema = Type.Object(
  {
    choices: nullable(
      Type.Array(
        Type.Object(
          {
            delta: nullable(
              Type.Object(
                {
                  content: nullable(Type.String()),
                  tool_calls: nullable(Type.Array(ChatToolCallDeltaSchema)),
                },
                { additionalProperties: true },
              ),
            ),
            finish_reason: nullable(Type.String()),
          },
          { additionalProperties: true },
        ),
      ),
    ),
    usage: nullable(
      Type.Object(
        { prompt_tokens: nullable(Type.Number()), completion_tokens: nullable(Type.Number()) },
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
// Generalized adapter factory
// ---------------------------------------------------------------------------

export function makeChatCompletionsAdapter(opts: {
  baseUrl: string
  apiKey: string | null
  label: string
}): ProviderAdapter<ChatTurn> {
  const { baseUrl, apiKey, label } = opts
  return {
    label,
    endpoint: `${normalizeOpenAiBaseUrl(baseUrl)}/v1/chat/completions`,
    buildHeaders() {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      return headers
    },
    mapHistory(req) {
      return mapChatHistory(req.systemPrompt, req.messages)
    },
    buildRequestBody(messages, req) {
      const body: Record<string, unknown> = {
        model: req.modelId,
        // Repair here, not in the callers: every driver sharing this adapter
        // (Custom Provider, Ollama, …) then emits a strictly pairable array.
        messages: sanitizeToolPairing(messages.flat()),
        stream: true,
        stream_options: { include_usage: true },
      }
      if (req.tools.length > 0) {
        body.tools = req.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
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
