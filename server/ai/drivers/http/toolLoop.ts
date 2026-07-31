/**
 * Provider-agnostic multi-turn tool loop for the direct HTTP drivers.
 *
 * Owns the agentic loop that the provider SDKs used to own:
 *
 *   1. Map the canonical `AiMessage[]` history into the provider's native
 *      message array (`adapter.mapHistory`).
 *   2. POST `{ ...body, stream: true }` and parse the SSE response into
 *      canonical `AiStreamEvent`s via a per-turn `TurnTranslator`.
 *   3. When the turn ends with tool calls, execute each (server handler or
 *      browser bridge) via `executeAiTool`, append the assistant `tool_use`
 *      turn + the `tool_result` turn to the working message array, and
 *      re-POST.
 *   4. Loop until the provider signals no more tool calls, then emit one
 *      aggregated `usage` event.
 *
 * Each provider supplies the small `ProviderAdapter` of pure functions; the
 * loop, SSE plumbing, tool dispatch, abort handling, and usage aggregation
 * live here once.
 *
 * Abort: `req.signal` is passed straight to `fetch`. On abort (or an
 * `AbortError` mid-stream) the generator returns cleanly with no `error`
 * event — matching the prior SDK behaviour.
 */

import type {
  AiContentBlock,
  AiMessage,
  AiStreamEvent,
  AiTool,
  AiToolOutput,
} from '../../runtime/types'
import type { AiStreamRequest } from '../types'
import { parseSseStream, type SseFrame } from './sse'
import { executeAiTool } from './execTool'
import { isAbortError, classifyHttpFailure } from './errors'

export const PROVIDER_RETRY_IMAGE_OMITTED =
  '[Earlier attached images omitted after the provider rejected the full conversation context.]'

/** A resolved tool call the model issued this turn. */
export interface TurnToolCall {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/** The result of executing one tool, paired back with its call. */
export interface TurnToolResult {
  readonly id: string
  readonly name: string
  readonly output: AiToolOutput
}

/** Per-turn token usage reported by the provider. */
export interface TurnUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheReadTokens?: number
  readonly cacheCreationTokens?: number
  /** Native USD cost, when the provider reports it (OpenRouter). */
  readonly costUsd?: number
}

/** What a finished turn yields to the loop. */
export interface TurnResult<TMessage> {
  /** True when the model is done (no tool calls / a non-tool stop reason). */
  readonly stop: boolean
  /** Tool calls to execute before the next turn. Empty when `stop`. */
  readonly toolCalls: TurnToolCall[]
  /**
   * The provider-native assistant turn to append before the tool results.
   * Null when there is nothing to append (e.g. a stop turn).
   */
  readonly assistantMessage: TMessage | null
  /** Token usage for this single API call, if reported. */
  readonly usage: TurnUsage | null
}

/**
 * Stateful translator for ONE API call. The loop feeds it every SSE frame via
 * `translate` (which yields wire events), then calls `finish` once the stream
 * ends to collect the assistant turn, tool calls, usage, and stop signal.
 */
export interface TurnTranslator<TMessage> {
  translate(frame: SseFrame): AiStreamEvent[]
  finish(): TurnResult<TMessage>
}

/** The per-provider plumbing the loop needs. `TMessage` is the provider's native message shape. */
export interface ProviderAdapter<TMessage> {
  readonly label: string
  readonly endpoint: string
  buildHeaders(req: AiStreamRequest): Record<string, string>
  /** Canonical `AiMessage[]` history → provider-native message array. */
  mapHistory(req: AiStreamRequest): TMessage[]
  /** Provider-native messages → the full JSON request body (sets `stream: true`). */
  buildRequestBody(messages: TMessage[], req: AiStreamRequest): unknown
  /** Build the tool-result turn appended after the assistant turn. */
  buildToolResultMessage(results: TurnToolResult[]): TMessage
  /** Fresh translator for each API call in the loop. */
  createTurnTranslator(): TurnTranslator<TMessage>
}

/**
 * Drive the multi-turn loop for one provider. Yields canonical
 * `AiStreamEvent`s; the runner forwards them to the wire + DB.
 */
export async function* runToolLoop<TMessage>(
  adapter: ProviderAdapter<TMessage>,
  req: AiStreamRequest,
): AsyncIterable<AiStreamEvent> {
  const toolsByName = new Map<string, AiTool>(req.tools.map((t) => [t.name, t]))
  let messages = adapter.mapHistory(req)
  const headers = adapter.buildHeaders(req)
  let initialProviderRound = true
  let replayOverflowRetried = false

  // Track tool-result messages that carry heavy evidence (screenshots,
  // full-page HTML/CSS). Once superseded they describe stale page state and are
  // worthless, so we keep only the LATEST per heavy tool name at full fidelity
  // and stub the rest — this is what bounds context growth across a long build
  // loop (a single screenshot inlined as text was blowing past 1M tokens).
  const heavyMessages: { index: number; results: TurnToolResult[] }[] = []

  // Usage is reported per API call; aggregate across the whole loop so the
  // runner persists a single total (and prices it via pricing.ts when the
  // provider omits costUsd).
  let promptTokens = 0
  let completionTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let costUsd: number | undefined

  const aggregateUsageEvent = (): Extract<AiStreamEvent, { type: 'usage' }> => ({
    type: 'usage',
    promptTokens,
    completionTokens,
    costUsd,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: cacheCreationTokens || undefined,
  })

  for (;;) {
    if (req.signal.aborted) return

    let res: Response
    try {
      res = await fetch(adapter.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(adapter.buildRequestBody(messages, req)),
        signal: req.signal,
      })
    } catch (err) {
      if (isAbortError(err) || req.signal.aborted) return
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[ai/${adapter.label.toLowerCase()}] request failed:`, err)
      yield { type: 'error', message: `${adapter.label} request failed: ${detail}` }
      return
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(`[ai/${adapter.label.toLowerCase()}] HTTP ${res.status}:`, bodyText.slice(0, 500))
      const failure = classifyHttpFailure(adapter.label, res.status, bodyText)
      if (initialProviderRound && !replayOverflowRetried && failure.kind === 'replayOverflow') {
        const projected = elideHistoricalUserImages(req.messages)
        if (projected) {
          replayOverflowRetried = true
          messages = adapter.mapHistory({ ...req, messages: projected })
          continue
        }
      }
      yield { type: 'error', message: failure.message }
      return
    }

    const translator = adapter.createTurnTranslator()
    try {
      for await (const frame of parseSseStream(res)) {
        for (const event of translator.translate(frame)) {
          yield event
          if (event.type === 'error') return
        }
      }
    } catch (err) {
      if (isAbortError(err) || req.signal.aborted) return
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[ai/${adapter.label.toLowerCase()}] stream error:`, err)
      yield { type: 'error', message: `${adapter.label} stream error: ${detail}` }
      return
    }

    if (req.signal.aborted) return

    const turn = translator.finish()
    initialProviderRound = false
    if (turn.usage) {
      promptTokens += turn.usage.promptTokens
      completionTokens += turn.usage.completionTokens
      cacheReadTokens += turn.usage.cacheReadTokens ?? 0
      cacheCreationTokens += turn.usage.cacheCreationTokens ?? 0
      if (turn.usage.costUsd != null) costUsd = (costUsd ?? 0) + turn.usage.costUsd
      // Live meter: emit THIS round's input as the current context size. Each
      // round (including the final one, before the break below) reports the
      // running context — the handler normalises + forwards it so the meter
      // updates mid-turn instead of only at the end.
      yield {
        type: 'context',
        promptTokens: turn.usage.promptTokens,
        cacheReadTokens: turn.usage.cacheReadTokens,
        cacheCreationTokens: turn.usage.cacheCreationTokens,
      }
    }

    if (turn.stop || turn.toolCalls.length === 0) {
      break
    }

    if (turn.assistantMessage !== null) {
      messages.push(turn.assistantMessage)
    }

    // Execute every tool the model requested this turn, then append the
    // combined tool-result turn before re-POSTing.
    const results: TurnToolResult[] = []
    for (const call of turn.toolCalls) {
      const tool = toolsByName.get(call.name)
      const input = prepareToolInput(call, req)
      let output: AiToolOutput
      try {
        output = tool
          ? await executeAiTool(tool, input, req.bridge, req.signal, req.toolContextBase)
          : { ok: false, error: `Unknown tool: ${call.name}` }
      } catch (err) {
        // Browser tools communicate domain failures by resolving an
        // `AiToolOutput`. Rejection means the bridge transport disappeared
        // (timeout, server reload, closed stream). Retrying within this turn
        // would hit the same dead bridge and can burn repeated provider rounds.
        if (req.signal.aborted) return
        const detail = err instanceof Error ? err.message : String(err)
        yield {
          type: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          ok: false,
          error: detail,
        }
        // The provider already completed and billed this round before the
        // bridge failed. Persist its accumulated usage before the terminal
        // error so conversation totals and the failed-turn audit stay honest.
        yield aggregateUsageEvent()
        yield {
          type: 'error',
          message: `Browser tool transport failed: ${detail}`,
        }
        return
      }
      yield {
        type: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        ok: output.ok,
        error: output.ok ? undefined : output.error ?? 'Tool call failed.',
      }
      results.push({ id: call.id, name: call.name, output })
      if (req.signal.aborted) return
    }

    const msgIndex = messages.push(adapter.buildToolResultMessage(results)) - 1
    if (results.some(isHeavyResult)) {
      heavyMessages.push({ index: msgIndex, results })
      applyHeavyElision(messages, heavyMessages, adapter)
    }
  }

  yield aggregateUsageEvent()
}

/**
 * One provider-directed retry projection: retain the newest/current user
 * turn verbatim and replace images on earlier user turns with one breadcrumb
 * per turn. Persistence and the caller-owned history remain untouched.
 */
function elideHistoricalUserImages(messages: readonly AiMessage[]): AiMessage[] | null {
  let newestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      newestUserIndex = index
      break
    }
  }
  if (newestUserIndex <= 0) return null

  let changed = false
  const projected = messages.map((message, messageIndex): AiMessage => {
    if (messageIndex >= newestUserIndex || message.role !== 'user') return message
    if (!message.content.some((block) => block.kind === 'image')) return message

    changed = true
    let breadcrumbAdded = false
    const content: AiContentBlock[] = []
    for (const block of message.content) {
      if (block.kind !== 'image') {
        content.push(block)
      } else if (!breadcrumbAdded) {
        content.push({ kind: 'text', text: PROVIDER_RETRY_IMAGE_OMITTED })
        breadcrumbAdded = true
      }
    }
    return { role: 'user', content }
  })
  return changed ? projected : null
}

// ---------------------------------------------------------------------------
// Per-tool input preparation
// ---------------------------------------------------------------------------

/**
 * Hook for server-controlled tool inputs the model shouldn't drive. Currently
 * just `site_render_snapshot`: the server injects `captureScreenshot` from the
 * active model's vision capability so a non-vision model never pays the
 * html-to-image cost for a screenshot it can't consume.
 */
function prepareToolInput(call: TurnToolCall, req: AiStreamRequest): unknown {
  if (call.name === 'site_render_snapshot') {
    const base = call.input && typeof call.input === 'object' ? call.input : {}
    return {
      ...base,
      captureScreenshot:
        req.modelCapabilities.visionInput && req.modelCapabilities.toolResultImages,
    }
  }
  return call.input
}

// ---------------------------------------------------------------------------
// Stale heavy-evidence elision
// ---------------------------------------------------------------------------

/**
 * Tools whose results carry heavy, snapshot-in-time payloads (a full page's
 * HTML/CSS, a node subtree, a screenshot). Older copies describe page state the
 * model has since mutated — useless to re-send. Any result with an image
 * attachment is heavy regardless of tool name.
 */
const HEAVY_TOOL_NAMES = new Set(['site_render_snapshot', 'site_read_document', 'site_get_node_html'])

function isHeavyResult(r: TurnToolResult): boolean {
  return (r.output.images?.length ?? 0) > 0 || HEAVY_TOOL_NAMES.has(r.name)
}

/** Replace a heavy payload with a one-line breadcrumb pointing back at the tool. */
function stubHeavyResult(r: TurnToolResult): TurnToolResult {
  return {
    ...r,
    output: {
      ok: r.output.ok,
      data: {
        elided: true,
        note: `Earlier ${r.name} output removed to conserve context. Call ${r.name} again if you need the current state.`,
      },
    },
  }
}

/**
 * Rewrite every tracked heavy tool-result message so that, per heavy tool name,
 * only the most recent message keeps full fidelity; all earlier heavy results
 * are stubbed. Non-heavy results in the same message are left untouched (a turn
 * can mix a heavy `site_read_document` with a cheap `site_update_node_props`). Messages are
 * rebuilt through the adapter so this stays provider-agnostic.
 */
function applyHeavyElision<TMessage>(
  messages: TMessage[],
  heavyMessages: { index: number; results: TurnToolResult[] }[],
  adapter: ProviderAdapter<TMessage>,
): void {
  const lastIndexByTool = new Map<string, number>()
  for (const m of heavyMessages) {
    for (const r of m.results) {
      if (isHeavyResult(r)) lastIndexByTool.set(r.name, m.index)
    }
  }
  for (const m of heavyMessages) {
    const rebuilt = m.results.map((r) =>
      isHeavyResult(r) && lastIndexByTool.get(r.name) !== m.index ? stubHeavyResult(r) : r,
    )
    messages[m.index] = adapter.buildToolResultMessage(rebuilt)
  }
}
