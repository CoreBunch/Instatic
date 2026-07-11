/**
 * Server → browser stream protocol.
 *
 * Owns the NDJSON envelope schema (`ServerStreamEventSchema`) used to validate
 * each line the server emits, and the `processStreamEvent` reducer that folds
 * one validated event into the agent slice's message state.
 *
 * Wire protocol (server → browser, NDJSON, one ServerStreamEvent per line):
 *   bridgeReady   first event; carries bridgeId for tool-result POSTs
 *   text          chunk of assistant text
 *   toolCall      driver issued a tool call (status: pending)
 *   toolResult    a previously-issued tool call completed (ok/error)
 *   toolRequest   server asks the browser to apply a write tool
 *   usage         per-turn token + cost totals
 *   error         server-side terminal error
 *   done          stream finished cleanly
 *
 * When a `toolRequest` arrives, the browser dispatches it through the
 * executor (which validates inputs and mutates the Zustand store), then POSTs
 * the result via `postToolResult` so the server-side MCP tool handler can
 * return the result to Claude. There is no separate <instatic:actions> DSL — every
 * page mutation is a real MCP tool call.
 */

import { nanoid } from 'nanoid'
import { aiToolError, type AiToolOutput } from '@core/ai'
import { Type } from '@core/utils/typeboxHelpers'
import { postToolResult } from '@admin/ai/toolResultApi'
import type { EditorStoreSet } from './agentSliceTypes'
import type {
  AgentBridgeRuntime,
  AgentTextStreamSink,
  AgentToolCall,
  ServerStreamEvent,
} from './types'
import { getErrorMessage } from '@core/utils/errorMessage'

// ---------------------------------------------------------------------------
// Stream-event schema
//
// Discriminated union mirrors ServerStreamEvent from ./types. Tool-input
// payloads pass through as Unknown — the executor validates each call's input
// at the dispatch boundary. The schema here catches malformed envelopes from
// the server, which is the failure mode the streaming reader needs to defend
// against.
// ---------------------------------------------------------------------------

export const ServerStreamEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({
    type: Type.Literal('bridgeReady'),
    bridgeId: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal('toolCall'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    input: Type.Unknown(),
    status: Type.Literal('pending'),
  }),
  Type.Object({
    type: Type.Literal('toolResult'),
    toolCallId: Type.String(),
    toolName: Type.String(),
    ok: Type.Boolean(),
    error: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('usage'),
    promptTokens: Type.Number(),
    completionTokens: Type.Number(),
    costUsd: Type.Optional(Type.Number()),
  }),
  Type.Object({
    // Per-round context size — drives the live meter mid-turn. `contextTokens`
    // is the handler-injected, provider-normalised input for that round.
    type: Type.Literal('context'),
    contextTokens: Type.Number(),
  }),
  Type.Object({ type: Type.Literal('done') }),
  Type.Object({ type: Type.Literal('error'), message: Type.String() }),
])

// ---------------------------------------------------------------------------
// Stream event processor
// ---------------------------------------------------------------------------

export async function processStreamEvent(
  event: ServerStreamEvent,
  assistantId: string,
  textSink: AgentTextStreamSink,
  set: EditorStoreSet,
  bridge: AgentBridgeRuntime,
  signal: AbortSignal | null,
  dispatchTool: (toolName: string, input: unknown) => Promise<AiToolOutput>,
  /**
   * Capture the current scope snapshot AFTER a browser tool runs. Posted with
   * the tool result so the server refreshes the turn context and later read
   * tools see post-mutation state. Optional — omit and no snapshot is sent.
   */
  buildSnapshot?: () => unknown,
): Promise<void> {
  switch (event.type) {
    case 'text': {
      textSink.append(assistantId, event.text)
      break
    }

    case 'bridgeReady': {
      bridge.bridgeId = event.bridgeId
      break
    }

    case 'toolRequest': {
      // Defensive: the dispatcher already converts caught throws into
      // `{ ok: false, error }`, but if anything ever escapes (or if
      // the bridge evolves) we still need to ALWAYS POST a result so the
      // server's bridge resolver fires and the driver loop sees a tool
      // error rather than hanging forever.
      let result: AiToolOutput
      try {
        result = await dispatchTool(event.toolName, event.input)
      } catch (err) {
        const message = getErrorMessage(err, String(err))
        console.error(`[AgentSlice] tool ${event.toolName} threw unexpectedly:`, err)
        result = aiToolError(`Browser exception: ${message}`)
      }
      // A browser tool may return preview images (for example render_snapshot).
      // Stash them on the matching pending tool-call block so the panel can show
      // what the agent looked at. The `toolCall` event for this call already
      // created the block, and tool calls are sequential, so exactly one block
      // for this tool is pending. The full tool result is posted to the active
      // provider turn below, but preview URLs are session-only and are not
      // persisted in conversation history, so they rehydrate empty on reload.
      const previewImages = result.ok
        ? result.images?.map((image) => `data:${image.mimeType};base64,${image.data}`)
        : undefined
      if (previewImages?.length) {
        set((state) => {
          const msg = state.agentMessages.find((m) => m.id === assistantId)
          const block = msg?.blocks.find(
            (b): b is { kind: 'toolCall'; toolCall: AgentToolCall } =>
              b.kind === 'toolCall'
              && b.toolCall.actionType === event.toolName
              && b.toolCall.status === 'pending',
          )
          if (block) block.toolCall.previewImages = previewImages
        })
      }
      if (!bridge.bridgeId) {
        console.error('[AgentSlice] toolRequest received before bridgeReady')
        break
      }
      // Snapshot AFTER the tool ran so the server sees the mutation it made.
      const snapshot = buildSnapshot?.()
      await postToolResult(bridge.bridgeId, event.requestId, result, signal, snapshot)
      break
    }

    case 'toolCall': {
      // Driver issued a tool call (status: pending). Drain any pending text
      // deltas BEFORE adding the block so the chronological order
      // text → tool → text is preserved.
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        const inputAsRecord = event.input && typeof event.input === 'object'
          ? (event.input as Record<string, unknown>)
          : null
        const existing = msg.blocks.find(
          (block): block is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            block.kind === 'toolCall' && block.toolCall.externalId === event.toolCallId,
        )
        if (existing) {
          // Re-emitted (e.g. Anthropic's content_block_start then _stop):
          // refresh the input but keep the pending status.
          if (inputAsRecord) existing.toolCall.params = inputAsRecord
          return
        }
        msg.blocks.push({
          kind: 'toolCall',
          toolCall: {
            id: nanoid(),
            externalId: event.toolCallId,
            actionType: event.toolName,
            params: inputAsRecord ?? {},
            result: null,
            status: 'pending',
          },
        })
      })
      break
    }

    case 'toolResult': {
      // Paired with the preceding `toolCall` (matched by toolCallId).
      // Flip its status to success/error + attach the result envelope so
      // the UI can render any failure message inline with the badge.
      textSink.flush()
      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return
        const block = msg.blocks.find(
          (b): b is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            b.kind === 'toolCall' && b.toolCall.externalId === event.toolCallId,
        )
        if (!block) return
        block.toolCall.status = event.ok ? 'success' : 'error'
        block.toolCall.result = {
          ok: event.ok,
          error: event.ok ? undefined : event.error ?? 'Tool call failed.',
        }
      })
      break
    }

    case 'usage': {
      // Token + cost totals are persisted server-side automatically; nothing
      // to do client-side. The context meter is driven by `context` events.
      break
    }

    case 'context': {
      // Live "context used" meter: each provider round reports the current
      // context size (handler-injected, provider-normalised). Update on every
      // round so the meter climbs DURING a turn, not only at the end. The
      // window half is supplied by the view layer from the model catalogue.
      const used = event.contextTokens
      set((state) => {
        state.agentContextTokens = used
      })
      break
    }

    case 'error': {
      // Surface the server's error message verbatim — drivers already
      // classify and shape these to be user-facing (auth/billing/quota
      // shows actionable copy, raw stack traces are stripped at the driver
      // boundary). The admin needs the actual reason, not a "Something
      // went wrong" placeholder; this surface is admin-only (capability
      // gated) so info-disclosure concerns don't apply.
      console.error('[AgentSlice] Server error event:', event.message)
      set({ agentError: event.message })
      break
    }

    case 'done':
    default:
      break
  }
}
