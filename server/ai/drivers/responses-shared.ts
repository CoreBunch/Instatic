/**
 * Shared OpenAI-Responses translation layer for the direct HTTP drivers.
 *
 * Both `openai.ts` and `openrouter.ts` speak the OpenAI **Responses** wire
 * protocol (`POST /v1/responses`), so the message mapping, tool declaration,
 * SSE→AiStreamEvent translation, and the `ProviderAdapter` that drives
 * `runToolLoop` live here once. The two drivers differ only in endpoint,
 * auth headers, model catalogue, and (OpenRouter only) native cost — those
 * stay in their own files.
 *
 * Tools are declared with their canonical TypeBox `inputSchema` as the JSON
 * Schema `parameters` directly — TypeBox schemas ARE JSON Schema, and the
 * `[Kind]` symbol they carry is dropped by `JSON.stringify` when the request
 * body is serialised, so there is no Zod bridge. `strict` is intentionally
 * omitted (see §11 of the plan): strict mode requires `additionalProperties:
 * false` + every property required, which our optional-bearing schemas violate.
 */

import { Type, parseValue, type Static } from '@core/utils/typeboxHelpers'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  type AiContentBlock,
  type AiMessage,
  type AiStreamEvent,
  type AiToolOutput,
} from '../runtime/types'
import type { AiStreamRequest } from './types'
import {
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

// ---------------------------------------------------------------------------
// Provider-native Responses `input` item shapes (request side — we construct)
// ---------------------------------------------------------------------------

/** A content part inside a Responses `message` item. */
type ResponsesContentPart =
  // User/system text. Assistant replayed text uses `output_text` instead.
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  // Base64 data URL — `data:<mime>;base64,<payload>`. Responses accepts an
  // inline image this way without a separate upload step.
  | { type: 'input_image'; image_url: string }

/** One item in the Responses `input` array. */
export type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

// Each canonical `AiMessage` maps to one OR MORE Responses items (an assistant
// turn with text + N tool calls fans out into a message item plus N
// function_call items), so the loop's `TMessage` is an item *array* and the
// request body flattens `messages` before sending.
export type ResponsesTurn = ResponsesInputItem[]

// ---------------------------------------------------------------------------
// System prompt → `instructions`
// ---------------------------------------------------------------------------

/**
 * Flatten the canonical `systemPrompt` array into the single Responses
 * `instructions` string. The 3-element cached form
 * `[prefix, BOUNDARY, suffix]` is joined into one block. OpenAI prompt caching
 * is automatic; callers can add `prompt_cache_key` through the adapter options
 * to improve routing for repeated prefixes.
 */
export function joinInstructions(systemPrompt: string[]): string {
  return systemPrompt
    .filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// AiMessage[] → Responses `input` items
// ---------------------------------------------------------------------------

/**
 * Map the canonical conversation log into the Responses `input` array, grouped
 * per source message. Assistant `toolCall` blocks become standalone
 * `function_call` items and `role:'tool'` results become `function_call_output`
 * items, pairing on `call_id` exactly as the API requires for multi-turn
 * tool use.
 */
export function mapResponsesHistory(messages: AiMessage[]): ResponsesTurn[] {
  const out: ResponsesTurn[] = []
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push([{ type: 'message', role: 'user', content: userContent(msg.content) }])
    } else if (msg.role === 'assistant') {
      out.push(assistantItems(msg.content))
    } else if (msg.role === 'tool') {
      out.push([
        {
          type: 'function_call_output',
          call_id: msg.toolCallId,
          output: toolOutputToString(msg.output),
        },
      ])
    }
    // role:'system' never appears here — it's the `instructions` field.
  }
  return out
}

function userContent(blocks: AiContentBlock[]): ResponsesContentPart[] {
  const out: ResponsesContentPart[] = []
  for (const block of blocks) {
    if (block.kind === 'text') {
      out.push({ type: 'input_text', text: block.text })
    } else if (block.kind === 'image') {
      // Base64 data URL: data:image/png;base64,AAAA…
      out.push({ type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}` })
    }
    // user-authored toolCall blocks don't exist; ignore defensively.
  }
  return out
}

function assistantItems(blocks: AiContentBlock[]): ResponsesTurn {
  const items: ResponsesTurn = []
  const textParts: ResponsesContentPart[] = []
  const calls: ResponsesInputItem[] = []
  for (const block of blocks) {
    if (block.kind === 'text') {
      if (block.text) textParts.push({ type: 'output_text', text: block.text })
    } else if (block.kind === 'toolCall') {
      calls.push({
        type: 'function_call',
        call_id: block.toolCallId,
        name: block.toolName,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }
  if (textParts.length > 0) items.push({ type: 'message', role: 'assistant', content: textParts })
  items.push(...calls)
  return items
}

function toolOutputToString(output: AiToolOutput): string {
  if (!output.ok) return output.error ?? 'Tool call failed.'
  const text = JSON.stringify(output.data ?? { ok: true })
  // The Responses `function_call_output` item is text-only — images can't ride
  // in a tool result here (they'd need a separate user message). Drop with a
  // note so the model knows visual evidence exists.
  if (output.images && output.images.length > 0) {
    return `${text}\n\n[${output.images.length} screenshot(s) omitted: this provider delivers tool results as text only.]`
  }
  return text
}

// ---------------------------------------------------------------------------
// Tools → Responses function declarations
// ---------------------------------------------------------------------------

function buildResponsesTools(tools: AiStreamRequest['tools']): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    // The TypeBox schema IS JSON Schema — pass it straight through. `strict`
    // is omitted on purpose; see the module header.
    parameters: t.inputSchema,
  }))
}

// ---------------------------------------------------------------------------
// SSE event schema (boundary validation — no `as` on parsed JSON)
// ---------------------------------------------------------------------------

const ResponsesUsageSchema = Type.Object(
  {
    input_tokens: Type.Optional(Type.Number()),
    output_tokens: Type.Optional(Type.Number()),
    // OpenRouter-only native USD cost; OpenAI omits it.
    cost: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    input_tokens_details: Type.Optional(
      Type.Object({ cached_tokens: Type.Optional(Type.Number()) }, { additionalProperties: true }),
    ),
  },
  { additionalProperties: true },
)

const ResponsesEventSchema = Type.Object(
  {
    type: Type.String(),
    delta: Type.Optional(Type.String()),
    item: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          call_id: Type.Optional(Type.String()),
          // Some gateways echo the call id only as `id`; accept it as a fallback.
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          arguments: Type.Optional(Type.String()),
        },
        { additionalProperties: true },
      ),
    ),
    response: Type.Optional(
      Type.Object({ usage: Type.Optional(ResponsesUsageSchema) }, { additionalProperties: true }),
    ),
    // `error` events carry a top-level message.
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// SSE translator — one per API call in the loop
// ---------------------------------------------------------------------------

/** A function call the model emitted this turn, in stream order. */
interface PendingCall {
  readonly call_id: string
  readonly name: string
  readonly arguments: string
}

export class ResponsesTurnTranslator implements TurnTranslator<ResponsesTurn> {
  private text = ''
  private readonly calls: PendingCall[] = []
  private readonly toolCalls: TurnToolCall[] = []
  private usage: TurnUsage | null = null

  translate(frame: SseFrame): AiStreamEvent[] {
    let event: Static<typeof ResponsesEventSchema>
    try {
      event = parseValue(ResponsesEventSchema, JSON.parse(frame.data))
    } catch {
      // Keep-alive / unparseable frame — not fatal.
      return []
    }

    switch (event.type) {
      case 'response.output_text.delta': {
        const delta = event.delta
        if (typeof delta === 'string' && delta.length > 0) {
          this.text += delta
          return [{ type: 'text', text: delta }]
        }
        return []
      }

      case 'response.output_item.done': {
        const item = event.item
        if (!item || item.type !== 'function_call') return []
        const callId = item.call_id ?? item.id ?? `tool-${nanoid()}`
        const name = item.name ?? 'tool'
        const args = typeof item.arguments === 'string' ? item.arguments : ''
        this.calls.push({ call_id: callId, name, arguments: args })
        const input = parseToolArguments(args)
        this.toolCalls.push({ id: callId, name, input })
        return [{ type: 'toolCall', toolCallId: callId, toolName: name, input, status: 'pending' }]
      }

      case 'response.completed': {
        const usage = event.response?.usage
        this.usage = {
          promptTokens: usage?.input_tokens ?? 0,
          completionTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.input_tokens_details?.cached_tokens,
          // OpenRouter reports native USD cost — pass it through so the
          // persister skips the static price table. OpenAI omits it (undefined
          // ⇒ priced by pricing.ts).
          costUsd: typeof usage?.cost === 'number' ? usage.cost : undefined,
        }
        return []
      }

      case 'response.failed':
        return [
          {
            type: 'error',
            message:
              'Provider response failed. Check your credentials and model in /admin/ai/providers.',
          },
        ]

      case 'error':
        return [
          {
            type: 'error',
            message: event.message ? `Provider error: ${event.message}` : 'Provider stream failed.',
          },
        ]

      default:
        return []
    }
  }

  finish(): TurnResult<ResponsesTurn> {
    const items: ResponsesTurn = []
    if (this.text) {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: this.text }] })
    }
    for (const call of this.calls) {
      items.push({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments })
    }
    return {
      // The loop continues while the turn produced function_call items.
      stop: this.toolCalls.length === 0,
      toolCalls: this.toolCalls,
      assistantMessage: items.length > 0 ? items : null,
      usage: this.usage,
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter factory — openai + openrouter share everything but transport
// ---------------------------------------------------------------------------

interface ResponsesAdapterOptions {
  readonly label: string
  readonly endpoint: string
  buildHeaders(req: AiStreamRequest): Record<string, string>
  promptCacheKey?: (req: AiStreamRequest) => string | null
}

/**
 * Build the `ProviderAdapter` that drives `runToolLoop` for any OpenAI-Responses
 * endpoint. Callers supply the label, endpoint, and auth headers; the message
 * mapping, request body, tool-result pairing, and SSE translation are shared.
 */
export function createResponsesAdapter(
  opts: ResponsesAdapterOptions,
): ProviderAdapter<ResponsesTurn> {
  return {
    label: opts.label,
    endpoint: opts.endpoint,
    buildHeaders: opts.buildHeaders,

    mapHistory(req) {
      return mapResponsesHistory(req.messages)
    },

    buildRequestBody(messages, req) {
      const body: Record<string, unknown> = {
        model: req.modelId,
        instructions: joinInstructions(req.systemPrompt),
        input: messages.flat(),
        stream: true,
      }
      const promptCacheKey = opts.promptCacheKey?.(req)
      if (promptCacheKey) body.prompt_cache_key = promptCacheKey
      if (req.tools.length > 0) body.tools = buildResponsesTools(req.tools)
      return body
    },

    buildToolResultMessage(results: TurnToolResult[]): ResponsesTurn {
      return results.map((r) => ({
        type: 'function_call_output' as const,
        call_id: r.id,
        output: toolOutputToString(r.output),
      }))
    },

    createTurnTranslator() {
      return new ResponsesTurnTranslator()
    },
  }
}
