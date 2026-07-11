/**
 * Anthropic driver — direct HTTP against the Messages API.
 *
 * Talks to `POST https://api.anthropic.com/v1/messages` with no SDK: the
 * shared `http/` layer owns SSE parsing, the multi-turn tool loop, tool
 * execution, and error classification; this file owns the Anthropic-specific
 * mapping — request body, `AiMessage[] → messages[]`, and the SSE→AiStreamEvent
 * translator.
 *
 * Prompt caching is GA (no beta header): the static system prefix carries
 * `cache_control: { type: 'ephemeral' }` so follow-up turns hit the cache.
 *
 * Tools are sent with their canonical TypeBox `inputSchema` as `input_schema`
 * directly — TypeBox schemas ARE JSON Schema, so there is no Zod bridge.
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
import { runToolLoop, type ProviderAdapter, type TurnResult, type TurnToolCall, type TurnToolResult, type TurnTranslator, type TurnUsage } from './http/toolLoop'
import type { SseFrame } from './http/sse'
import { parseToolArguments } from './http/toolArgs'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const ANTHROPIC_ENDPOINT = `${ANTHROPIC_BASE_URL}/messages`
const ANTHROPIC_MODELS_ENDPOINT = `${ANTHROPIC_BASE_URL}/models`
const ANTHROPIC_VERSION = '2023-06-01'

// Per-turn output cap. Anthropic requires `max_tokens`; the prior SDK left it
// to its own default. 8192 comfortably covers a single agent turn (a few
// insertHtml chunks + a short narration) without risking truncation; multi-turn
// work continues across loop iterations, not within one response.
const MAX_OUTPUT_TOKENS = 8192

export const anthropicDriver: AiProvider = {
  id: 'anthropic' as AiProviderId,
  label: 'Anthropic',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(_modelId: string) {
    // Every current Claude model tool-calls, accepts images, and supports
    // prompt caching. The picker shows the per-model flags from listModels();
    // this sync accessor only needs a safe default for the tool loop's vision
    // check, so it doesn't depend on the live catalogue.
    return {
      toolCalling: true,
      visionInput: true,
      toolResultImages: true,
      promptCache: true,
      streaming: true,
    }
  },

  async listModels(creds, signal) {
    return fetchAnthropicModels(creds, signal)
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      // Defensive: a non-apiKey credential reaching the driver implies a
      // mismatched DB row or a bypassed UI. Fail cleanly instead of POSTing
      // and getting a generic 401.
      yield {
        type: 'error',
        message:
          'Anthropic requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(anthropicAdapter, req)
  },
}

// ---------------------------------------------------------------------------
// Live model catalogue — GET /v1/models
// ---------------------------------------------------------------------------

const AnthropicCapabilityFlagSchema = Type.Object(
  { supported: Type.Optional(Type.Boolean()) },
  { additionalProperties: true },
)

const AnthropicModelInfoSchema = Type.Object(
  {
    id: Type.String(),
    display_name: Type.Optional(Type.String()),
    capabilities: Type.Optional(
      Type.Object(
        { image_input: Type.Optional(AnthropicCapabilityFlagSchema) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const AnthropicModelsResponseSchema = Type.Object(
  { data: Type.Array(AnthropicModelInfoSchema) },
  { additionalProperties: true },
)

/**
 * Fetch the live model catalogue from `GET /v1/models` (newest-first) so
 * freshly-released models surface without any code change. This is the only
 * source — there is no static fallback:
 *   - no API key ⇒ no catalogue, return an empty list (the picker shows nothing
 *     until a credential is selected); and
 *   - a failed request or unparseable body throws, so the caller surfaces the
 *     error rather than masking it with a stale hardcoded list.
 */
async function fetchAnthropicModels(
  creds: AiResolvedCredential,
  signal?: AbortSignal,
): Promise<AiProviderModel[]> {
  if (creds.authMode !== 'apiKey' || !creds.apiKey) return []

  const res = await fetch(`${ANTHROPIC_MODELS_ENDPOINT}?limit=1000`, {
    headers: {
      'x-api-key': creds.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    signal,
  })
  if (!res.ok) {
    throw new Error(`[ai/anthropic] models request failed: ${res.status} ${res.statusText}`)
  }
  // Validate the external API body at the boundary (no `as` cast).
  const parsed = parseValue(AnthropicModelsResponseSchema, await res.json())

  // The API lists models newest-first but carries no "tier" field, so derive
  // one from the family. The first (newest) Opus is the "smartest"; later
  // Opus entries are "smart". This mirrors the picker's existing badges.
  let opusSeen = false
  return parsed.data.map((model) => {
    const family = deriveTier(model.id, opusSeen)
    if (family.isOpus) opusSeen = true
    return {
      id: model.id,
      label: model.display_name ?? model.id,
      tier: family.tier,
      capabilities: {
        toolCalling: true,
        // Default to true when the flag is absent — every current Claude
        // model accepts image input; only honour an explicit `false`.
        visionInput: model.capabilities?.image_input?.supported ?? true,
        toolResultImages: true,
        promptCache: true,
        streaming: true,
      },
    } satisfies AiProviderModel
  })
}

function deriveTier(modelId: string, opusAlreadySeen: boolean): { tier: string | undefined; isOpus: boolean } {
  if (modelId.includes('opus')) return { tier: opusAlreadySeen ? 'smart' : 'smartest', isOpus: true }
  if (modelId.includes('sonnet')) return { tier: 'balanced', isOpus: false }
  if (modelId.includes('haiku')) return { tier: 'fast', isOpus: false }
  return { tier: undefined, isOpus: false }
}

// ---------------------------------------------------------------------------
// Provider-native message shapes (request side — we construct, never parse)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}
interface AnthropicImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}
interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  // Anthropic tool_result content accepts either a plain string or an array of
  // text/image blocks — the latter lets a tool return a screenshot as a NATIVE
  // image (≈1.5K tokens) instead of base64-as-JSON-text (hundreds of KB → 1M+).
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[]
  is_error?: boolean
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const anthropicAdapter: ProviderAdapter<AnthropicMessage> = {
  label: 'Anthropic',
  endpoint: ANTHROPIC_ENDPOINT,

  buildHeaders(req) {
    return {
      'x-api-key': req.credentials.apiKey!,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    }
  },

  mapHistory(req) {
    return mapHistory(req.messages)
  },

  buildRequestBody(messages, req) {
    const body: Record<string, unknown> = {
      model: req.modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: buildSystemBlocks(req.systemPrompt),
      messages,
      stream: true,
    }
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        // The TypeBox schema IS JSON Schema — pass it straight through.
        input_schema: t.inputSchema,
      }))
    }
    return body
  },

  buildToolResultMessage(results) {
    return buildToolResultMessage(results)
  },

  createTurnTranslator() {
    return new AnthropicTurnTranslator()
  },
}

// ---------------------------------------------------------------------------
// System prompt → system blocks
// ---------------------------------------------------------------------------

/**
 * Map the canonical `systemPrompt` array into Anthropic's `system` field.
 *
 *   - 3-element `[prefix, BOUNDARY, suffix]` → two text blocks, `cache_control`
 *     on the static prefix so it's served from the prompt cache on later turns.
 *   - 1-element `[text]` → the plain string (no caching).
 *   - any other length → joined into one uncached block (defensive).
 */
export function buildSystemBlocks(systemPrompt: string[]): string | AnthropicTextBlock[] {
  if (systemPrompt.length === 3 && systemPrompt[1] === SYSTEM_PROMPT_DYNAMIC_BOUNDARY) {
    return [
      { type: 'text', text: systemPrompt[0]!, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: systemPrompt[2]! },
    ]
  }
  if (systemPrompt.length === 1) {
    return systemPrompt[0]!
  }
  return systemPrompt.filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('\n\n')
}

// ---------------------------------------------------------------------------
// AiMessage[] → Anthropic messages[]
// ---------------------------------------------------------------------------

/**
 * Map the canonical conversation log into Anthropic's `messages` array.
 *
 * Anthropic requires strictly alternating user/assistant turns and pairs each
 * assistant `tool_use` block with a following `{ role:'user', content:[tool_result] }`
 * turn. The persisted log stores each tool call + result as separate rows, so
 * we coalesce consecutive assistant rows into one assistant turn and consecutive
 * `role:'tool'` rows into one user turn of `tool_result` blocks.
 */
export function mapHistory(messages: AiMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]!
    if (msg.role === 'user') {
      pushUserContent(out, userContent(msg.content))
      i += 1
    } else if (msg.role === 'assistant') {
      const content: AnthropicContentBlock[] = []
      while (i < messages.length && messages[i]!.role === 'assistant') {
        content.push(...assistantContent((messages[i] as Extract<AiMessage, { role: 'assistant' }>).content))
        i += 1
      }
      out.push({ role: 'assistant', content })
    } else if (msg.role === 'tool') {
      const content: AnthropicContentBlock[] = []
      while (i < messages.length && messages[i]!.role === 'tool') {
        content.push(toolResultBlock(messages[i] as Extract<AiMessage, { role: 'tool' }>))
        i += 1
      }
      pushUserContent(out, content)
    } else {
      // role:'system' never appears in `messages` (system is its own field).
      i += 1
    }
  }
  return out
}

/**
 * Append user-turn content, merging into the previous turn when it is also a
 * user turn. Anthropic requires strict user/assistant alternation, and the
 * `tool` branch above emits tool results as their own user turn. When an
 * aborted turn's synthetic tool results sit immediately before the next real
 * user prompt, that would produce two adjacent user turns; merging them yields
 * the canonical single user turn carrying `[tool_result…, text…]`.
 */
function pushUserContent(out: AnthropicMessage[], content: AnthropicContentBlock[]): void {
  const prev = out[out.length - 1]
  if (prev?.role === 'user') {
    prev.content.push(...content)
  } else {
    out.push({ role: 'user', content })
  }
}

function userContent(blocks: AiContentBlock[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = []
  for (const block of blocks) {
    if (block.kind === 'text') out.push({ type: 'text', text: block.text })
    else if (block.kind === 'image') {
      out.push({ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } })
    }
    // user-authored toolCall blocks don't exist; ignore defensively.
  }
  return out
}

function assistantContent(blocks: AiContentBlock[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = []
  for (const block of blocks) {
    if (block.kind === 'text') {
      if (block.text) out.push({ type: 'text', text: block.text })
    } else if (block.kind === 'toolCall') {
      out.push({ type: 'tool_use', id: block.toolCallId, name: block.toolName, input: block.input ?? {} })
    }
    // assistant image blocks don't occur; ignore.
  }
  return out
}

function toolResultBlock(msg: Extract<AiMessage, { role: 'tool' }>): AnthropicToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: msg.toolCallId,
    content: toolOutputToContent(msg.output),
    is_error: msg.output.ok ? undefined : true,
  }
}

function buildToolResultMessage(results: TurnToolResult[]): AnthropicMessage {
  return {
    role: 'user',
    content: results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.id,
      content: toolOutputToContent(r.output),
      is_error: r.output.ok ? undefined : true,
    })),
  }
}

function toolOutputToContent(
  output: AiToolOutput,
): string | (AnthropicTextBlock | AnthropicImageBlock)[] {
  if (!output.ok) return output.error ?? 'Tool call failed.'
  const text = JSON.stringify(output.data ?? { ok: true })
  if (!output.images || output.images.length === 0) return text
  // Mixed content: the JSON payload as text + each attached image as a native
  // image block. Anthropic bills the image at its rendered token cost, not the
  // base64 length, so this is the whole point of the multimodal channel.
  const blocks: (AnthropicTextBlock | AnthropicImageBlock)[] = [{ type: 'text', text }]
  for (const img of output.images) {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// SSE event schema (boundary validation — no `as` on parsed JSON)
// ---------------------------------------------------------------------------

const AnthropicUsageSchema = Type.Object(
  {
    input_tokens: Type.Optional(Type.Number()),
    output_tokens: Type.Optional(Type.Number()),
    cache_read_input_tokens: Type.Optional(Type.Number()),
    cache_creation_input_tokens: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

const AnthropicSseEventSchema = Type.Object(
  {
    type: Type.String(),
    index: Type.Optional(Type.Number()),
    content_block: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          id: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          input: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: true },
      ),
    ),
    delta: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          text: Type.Optional(Type.String()),
          partial_json: Type.Optional(Type.String()),
          stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        },
        { additionalProperties: true },
      ),
    ),
    message: Type.Optional(
      Type.Object(
        { usage: Type.Optional(AnthropicUsageSchema) },
        { additionalProperties: true },
      ),
    ),
    usage: Type.Optional(AnthropicUsageSchema),
    error: Type.Optional(
      Type.Object(
        { type: Type.Optional(Type.String()), message: Type.Optional(Type.String()) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// SSE translator — one per API call in the loop
// ---------------------------------------------------------------------------

interface MutableUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export class AnthropicTurnTranslator implements TurnTranslator<AnthropicMessage> {
  // Block order as it streams, so the assistant turn rebuilds text/tool_use
  // blocks in the sequence the model emitted them.
  private readonly order: number[] = []
  private readonly textByIndex = new Map<number, string>()
  private readonly toolByIndex = new Map<number, { id: string; name: string; json: string }>()
  private readonly toolCalls: TurnToolCall[] = []
  private usage: MutableUsage = {}
  private stopReason: string | null = null

  translate(frame: SseFrame): AiStreamEvent[] {
    let event: Static<typeof AnthropicSseEventSchema>
    try {
      event = parseValue(AnthropicSseEventSchema, JSON.parse(frame.data))
    } catch {
      // A frame we can't parse (keep-alive comment, malformed payload) is not
      // fatal — skip it.
      return []
    }

    switch (event.type) {
      case 'message_start':
        if (event.message?.usage) this.mergeUsage(event.message.usage)
        return []

      case 'content_block_start': {
        const index = event.index ?? 0
        const block = event.content_block
        if (block?.type === 'tool_use') {
          this.order.push(index)
          this.toolByIndex.set(index, {
            id: typeof block.id === 'string' ? block.id : `tool-${index}`,
            name: typeof block.name === 'string' ? block.name : 'tool',
            json: '',
          })
        } else if (block?.type === 'text') {
          this.order.push(index)
          this.textByIndex.set(index, '')
        }
        return []
      }

      case 'content_block_delta': {
        const index = event.index ?? 0
        const delta = event.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.textByIndex.set(index, (this.textByIndex.get(index) ?? '') + delta.text)
          return [{ type: 'text', text: delta.text }]
        }
        if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const tool = this.toolByIndex.get(index)
          if (tool) tool.json += delta.partial_json
        }
        return []
      }

      case 'content_block_stop': {
        const index = event.index ?? 0
        const tool = this.toolByIndex.get(index)
        if (!tool) return []
        const input = parseToolArguments(tool.json)
        this.toolCalls.push({ id: tool.id, name: tool.name, input })
        return [{
          type: 'toolCall',
          toolCallId: tool.id,
          toolName: tool.name,
          input,
          status: 'pending',
        }]
      }

      case 'message_delta': {
        if (typeof event.delta?.stop_reason === 'string') this.stopReason = event.delta.stop_reason
        if (event.usage) this.mergeUsage(event.usage)
        return []
      }

      case 'error': {
        const detail = event.error?.message
        return [{
          type: 'error',
          message: detail
            ? `Anthropic error: ${detail}`
            : 'Anthropic stream failed. Check your credentials in /admin/ai/providers.',
        }]
      }

      // message_stop, ping, and unrecognised events carry nothing we surface.
      default:
        return []
    }
  }

  finish(): TurnResult<AnthropicMessage> {
    const content: AnthropicContentBlock[] = []
    for (const index of this.order) {
      const text = this.textByIndex.get(index)
      if (text !== undefined) {
        if (text) content.push({ type: 'text', text })
        continue
      }
      const tool = this.toolByIndex.get(index)
      if (tool) {
        content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: parseToolArguments(tool.json) })
      }
    }

    return {
      stop: this.stopReason !== 'tool_use',
      toolCalls: this.toolCalls,
      assistantMessage: content.length > 0 ? { role: 'assistant', content } : null,
      usage: this.toTurnUsage(),
    }
  }

  private mergeUsage(usage: MutableUsage): void {
    // input/cache fields land on message_start; output_tokens is cumulative on
    // message_delta — last-wins captures the final values correctly.
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
      const value = usage[key]
      if (typeof value === 'number') this.usage[key] = value
    }
  }

  private toTurnUsage(): TurnUsage {
    return {
      promptTokens: this.usage.input_tokens ?? 0,
      completionTokens: this.usage.output_tokens ?? 0,
      cacheReadTokens: this.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: this.usage.cache_creation_input_tokens ?? 0,
    }
  }
}
