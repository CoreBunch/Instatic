/**
 * Chat runner — drives one driver.stream() to completion + persists each
 * event to the DB while forwarding the wire copy to the response stream.
 *
 * Sequence:
 *
 *   1. Handler creates a bridge via `createBridge(emit)` → bridgeId + sink.
 *   2. Handler emits the `bridgeReady` event.
 *   3. Handler calls `runChat({ driver, request, persister, emit })`.
 *   4. `runChat` iterates driver.stream(request), threading every event
 *      through `emit` (NDJSON to browser) AND `persister` (DB writes for
 *      assistant text + tool calls).
 *   5. `runChat` emits a final `done` (or `error`) and returns.
 *
 * No driver-specific knowledge here. The driver is the only thing that
 * touches its SDK; this module just stitches its events into the wire +
 * the database.
 */

import type { ConversationsPersister } from './persister'
import type { AiProvider, AiStreamRequest } from '../drivers/types'
import type { AiStreamEvent } from './types'

interface RunChatArgs {
  driver: AiProvider
  request: AiStreamRequest
  persister: ConversationsPersister
  emit(event: AiStreamEvent): void
}

/**
 * Run a single chat turn end-to-end. Throws nothing — terminal errors are
 * forwarded as `{ type: 'error', message }` events and the function returns
 * cleanly so the handler can run its finally-block (destroy bridge, close
 * the response stream).
 */
export async function runChat(args: RunChatArgs): Promise<void> {
  const { driver, request, persister, emit } = args

  // Per-turn assembly. Drivers stream `text` events as deltas; we
  // accumulate per assistant-message until the next non-text event lands,
  // at which point we flush an assistant row before recording the tool
  // call. This preserves text-then-tool chronological order in the
  // persisted history.
  let pendingAssistantText = ''
  const pendingToolCallsByCallId = new Map<string, { name: string; input: unknown }>()

  async function flushPendingAssistantText(): Promise<void> {
    if (!pendingAssistantText) return
    const text = pendingAssistantText
    pendingAssistantText = ''
    await persister.appendAssistantText(text)
  }

  try {
    for await (const event of driver.stream(request)) {
      // Always forward to the wire first so the browser sees the event
      // even if persistence fails (we never want to silently lose a UI
      // update because the DB is slow).
      emit(event)

      switch (event.type) {
        case 'text': {
          pendingAssistantText += event.text
          break
        }
        case 'toolCall': {
          await flushPendingAssistantText()
          pendingToolCallsByCallId.set(event.toolCallId, {
            name: event.toolName,
            input: event.input,
          })
          await persister.appendToolCall({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          })
          break
        }
        case 'toolResult': {
          const pending = pendingToolCallsByCallId.get(event.toolCallId)
          pendingToolCallsByCallId.delete(event.toolCallId)
          if (!event.ok) {
            // Surface failed tool calls server-side so the operator can
            // correlate a UI red-dot with a stack-trace / driver message
            // in the server log. The browser already sees the error text
            // (inline under the tool badge); this is the other half of
            // the diagnostic loop.
            console.error(
              `[ai/runner] tool failed — ${pending?.name ?? event.toolName} (${event.toolCallId}):`,
              event.error ?? 'no error message',
            )
          }
          await persister.appendToolResult({
            toolCallId: event.toolCallId,
            toolName: pending?.name ?? event.toolName,
            ok: event.ok,
            error: event.error,
          })
          break
        }
        case 'context': {
          // Track the latest round's context size in the persister (in-memory);
          // it's written to the conversation row once, with the final usage
          // event, so the meter restores to the true context on reload.
          persister.recordContext({
            promptTokens: event.promptTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
          })
          break
        }
        case 'usage': {
          await persister.recordUsage({
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            costUsd: event.costUsd,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
          })
          break
        }
        case 'error': {
          // Driver reported a terminal error. Flush whatever text accumulated
          // before bailing — the user still sees the partial assistant
          // message in their history.
          await flushPendingAssistantText()
          return
        }
        // `bridgeReady`, `toolRequest`, `done`: nothing to persist.
        default:
          break
      }
    }

    // Stream ended without explicit error or done — flush trailing text.
    await flushPendingAssistantText()
    emit({ type: 'done' })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // Log with the full Error (preserves the stack trace in the operator's
    // terminal). Forward a tagged message to the browser so the admin
    // can see the actual cause — this surface is capability-gated to
    // admins, not end users.
    console.error('[ai/runner] driver.stream() threw:', err)
    await flushPendingAssistantText().catch(() => { /* noop */ })
    emit({ type: 'error', message: `AI runtime error: ${detail}` })
  }
}
