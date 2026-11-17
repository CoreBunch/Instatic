/**
 * Claude Code stream-json → `AiStreamEvent` translation.
 *
 * The CLI emits one JSON object per line. This module is the only thing that
 * knows that wire format: it validates each line at the boundary and turns the
 * handful of event types Instatic cares about into chat events, while
 * accumulating the per-turn facts the driver needs to classify how the turn
 * ended (see `TranslateState`).
 *
 * Deliberately pure and synchronous — no subprocess, no IO — so the whole
 * translation layer is unit-testable from recorded CLI output.
 */

import { Type, parseValue, type Static } from '@core/utils/typeboxHelpers'
import type { AiStreamEvent } from '../runtime/types'

// ---------------------------------------------------------------------------

export interface TranslateState {
  sawText: boolean
  /** tool_use_id → display name, so tool_result events can name their call. */
  toolNames: Map<string, string>
  resultSeen: boolean
  /** The CLI announced its session (`system`/`init`) — tool counts are known. */
  sawInit: boolean
  /** How many `mcp__instatic__*` tools the CLI offered the model at init. */
  mcpToolCount: number
  /** The `instatic` server's status at init: 'connected' | 'failed' | 'pending'. */
  mcpServerStatus: string | null
  /** Output lines we could not read — a format drift canary, logged at the end. */
  unparseableLines: number
  toolCallCount: number
  /** Set when the subscription limit blocks the turn, surfaced as the error. */
  rateLimitMessage: string | null
  /** A failing `result` event, held for the caller to classify. */
  resultErrorMessage: string | null
}

/** Fresh per-attempt translation state. Exported for the driver's unit tests. */
export function createTranslateState(): TranslateState {
  return {
    sawText: false,
    toolNames: new Map(),
    resultSeen: false,
    sawInit: false,
    mcpToolCount: 0,
    mcpServerStatus: null,
    unparseableLines: 0,
    toolCallCount: 0,
    rateLimitMessage: null,
    resultErrorMessage: null,
  }
}

export function* translateLine(line: string, state: TranslateState): Generator<AiStreamEvent> {
  let evt: Static<typeof ClaudeCodeEventSchema>
  try {
    evt = parseValue(ClaudeCodeEventSchema, JSON.parse(line))
  } catch {
    // Keep-alive or a shape we don't model. Counted rather than silently
    // dropped: if the CLI's output format drifts, every event could start
    // landing here and the turn would go quiet for no visible reason.
    state.unparseableLines += 1
    return
  }

  switch (evt.type) {
    case 'system': {
      if (evt.subtype !== 'init') return
      state.sawInit = true
      const tools = Array.isArray(evt.tools) ? evt.tools : []
      state.mcpToolCount = tools.filter(
        (t) => typeof t === 'string' && t.startsWith('mcp__instatic__'),
      ).length
      const server = (evt.mcp_servers ?? []).find(
        (s): s is { name?: unknown; status?: unknown } =>
          !!s && typeof s === 'object' && (s as { name?: unknown }).name === 'instatic',
      )
      state.mcpServerStatus = typeof server?.status === 'string' ? server.status : null
      console.info(
        `[ai/claude-code] session ${evt.session_id ?? '?'} started — ` +
        `${state.mcpToolCount} CMS tool(s), mcp_servers=${JSON.stringify(evt.mcp_servers ?? [])}`,
      )
      return
    }
    case 'rate_limit_event': {
      // Subscription limit. `allowed` is the normal steady-state ping; anything
      // else means this turn is being throttled or refused, which otherwise
      // shows up as the CLI going quiet.
      const info = evt.rate_limit_info
      if (!info || info.status === 'allowed') return
      const resetsAt = typeof info.resetsAt === 'number'
        ? new Date(info.resetsAt * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
        : null
      state.rateLimitMessage =
        `Claude Code hit the ${info.rateLimitType ?? 'subscription'} limit on this machine's Claude ` +
        `subscription (status: ${info.status})${resetsAt ? `. Resets at ${resetsAt}` : ''}.`
      console.warn(`[ai/claude-code] ${state.rateLimitMessage}`)
      return
    }
    case 'stream_event': {
      // The nested `event` is a raw Anthropic SSE event. We only surface text
      // deltas here; tool calls come from the aggregate `assistant` message.
      const inner = evt.event
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        const text = inner.delta.text
        if (typeof text === 'string' && text) {
          state.sawText = true
          yield { type: 'text', text }
        }
      }
      return
    }
    case 'assistant': {
      for (const block of evt.message?.content ?? []) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          if (state.toolNames.has(block.id)) continue // already declared
          const name = stripMcpPrefix(typeof block.name === 'string' ? block.name : 'tool')
          state.toolNames.set(block.id, name)
          state.toolCallCount += 1
          yield {
            type: 'toolCall',
            toolCallId: block.id,
            toolName: name,
            input: block.input ?? {},
            status: 'pending',
          }
        }
      }
      return
    }
    case 'user': {
      // Tool results the CLI got back from the MCP server (executed against the
      // live workspace). Emit a matching toolResult for each so the chat closes
      // the tool-call badge.
      for (const block of evt.message?.content ?? []) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const name = state.toolNames.get(block.tool_use_id) ?? 'tool'
          yield {
            type: 'toolResult',
            toolCallId: block.tool_use_id,
            toolName: name,
            ok: block.is_error !== true,
            error: block.is_error === true ? toolErrorText(block.content) : undefined,
          }
        }
      }
      return
    }
    case 'result': {
      state.resultSeen = true
      const failed = evt.is_error === true || (evt.subtype != null && evt.subtype !== 'success')
      if (failed) {
        // Recorded, not yielded: the caller decides whether this is terminal or
        // a recoverable session mismatch worth retrying. Yielding here would
        // both pre-empt that choice and count as user-visible output.
        state.resultErrorMessage =
          `Claude Code turn failed${evt.subtype ? ` (${evt.subtype})` : ''}` +
          `${evt.result ? `: ${evt.result}` : ''}.`
        return
      }
      // Fallback: a response with no streamed text deltas — surface the final
      // result string so the turn isn't silent.
      if (!state.sawText && typeof evt.result === 'string' && evt.result) {
        yield { type: 'text', text: evt.result }
      }
      const u = evt.usage
      if (u) {
        const promptTokens = u.input_tokens ?? 0
        const cacheReadTokens = u.cache_read_input_tokens ?? 0
        const cacheCreationTokens = u.cache_creation_input_tokens ?? 0
        yield { type: 'context', promptTokens, cacheReadTokens, cacheCreationTokens }
        yield {
          type: 'usage',
          promptTokens,
          completionTokens: u.output_tokens ?? 0,
          cacheReadTokens,
          cacheCreationTokens,
        }
      }
      return
    }
    default:
      return
  }
}

function stripMcpPrefix(name: string): string {
  // mcp__instatic__site_insert_html → site_insert_html
  const m = name.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/)
  return m ? m[1]! : name.startsWith('mcp__') ? name.replace(/^mcp__[^_]*__/, '') : name
}

function toolErrorText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join(' ')
    if (text) return text
  }
  return 'Tool call failed.'
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const AnthropicUsageShape = Type.Object(
  {
    input_tokens: Type.Optional(Type.Number()),
    output_tokens: Type.Optional(Type.Number()),
    cache_read_input_tokens: Type.Optional(Type.Number()),
    cache_creation_input_tokens: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

const ContentBlockShape = Type.Object(
  {
    type: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    input: Type.Optional(Type.Unknown()),
    tool_use_id: Type.Optional(Type.String()),
    is_error: Type.Optional(Type.Boolean()),
    content: Type.Optional(Type.Unknown()),
    text: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

/** `system`/`init` announces the toolset the model will actually see. */
const RateLimitInfoShape = Type.Object(
  {
    status: Type.Optional(Type.String()),
    resetsAt: Type.Optional(Type.Number()),
    rateLimitType: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

const ClaudeCodeEventSchema = Type.Object(
  {
    type: Type.String(),
    subtype: Type.Optional(Type.String()),
    is_error: Type.Optional(Type.Boolean()),
    result: Type.Optional(Type.String()),
    usage: Type.Optional(AnthropicUsageShape),
    session_id: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
    mcp_servers: Type.Optional(Type.Array(Type.Unknown())),
    rate_limit_info: Type.Optional(RateLimitInfoShape),
    event: Type.Optional(
      Type.Object(
        {
          type: Type.Optional(Type.String()),
          delta: Type.Optional(
            Type.Object(
              { type: Type.Optional(Type.String()), text: Type.Optional(Type.String()) },
              { additionalProperties: true },
            ),
          ),
        },
        { additionalProperties: true },
      ),
    ),
    message: Type.Optional(
      Type.Object(
        { content: Type.Optional(Type.Array(ContentBlockShape)) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)
