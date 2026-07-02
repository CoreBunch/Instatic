/**
 * Reconstruct the canonical `AiMessage[]` history a driver replays each turn
 * from the persisted `MessageRecord` rows.
 *
 * The persister writes each tool call and its result as SEPARATE rows: an
 * assistant row carrying the `toolCall` block, then later a `role:'tool'` row
 * carrying the result. If a stream aborts BETWEEN those two writes — a server
 * restart mid-turn, a dropped connection (`ERR_INCOMPLETE_CHUNKED_ENCODING`),
 * an aborted request — the assistant `tool_use` row persists but its result
 * row never does. Replaying that history verbatim sends an unanswered
 * `tool_use` to the provider, which every provider rejects (Anthropic:
 * "tool_use ids were found without tool_result blocks immediately after").
 *
 * This module is the single boundary that turns DB rows into provider-replay
 * messages, so it is the right place to heal that gap: every `tool_use` left
 * unanswered by the persisted rows gets a synthetic error `tool_result`. The
 * model sees that the prior turn's tool call was interrupted and can retry,
 * instead of the whole conversation becoming permanently un-sendable.
 *
 * The opposite corruption can also happen: a `role:'tool'` result row may be
 * persisted without the assistant `toolCall` row that declared it. Those rows
 * are dropped here, because providers reject tool results that do not answer a
 * preceding tool call in the replayed history.
 */

import type { AiMessage, AiToolOutput } from '../runtime/types'
import type { MessageRecord } from './types'

/**
 * Error surfaced to the model for a tool call whose result was never persisted
 * because the turn was interrupted before it completed.
 */
export const INTERRUPTED_TOOL_RESULT_ERROR =
  'Tool call did not complete — the previous turn was interrupted before a result was produced.'

/**
 * Reconstruct `AiMessage` history from persisted `MessageRecord` rows.
 *
 * - `user` / `assistant` rows replay their content verbatim (assistant rows
 *   keep their `toolCall` blocks — they're the `tool_use` half of a pair).
 * - `tool` rows become `tool`-role results, mapped per driver into the
 *   provider's tool-result shape.
 * - Any assistant `toolCall` block not answered by a persisted `tool` row gets
 *   a synthetic error result inserted before the next user turn (or at the end
 *   of history), so no `tool_use` is ever left dangling.
 */
export function buildMessageHistory(records: MessageRecord[]): AiMessage[] {
  const out: AiMessage[] = []
  // Tool-call ids declared by the current assistant run that have not yet been
  // answered by a persisted tool result. Insertion order preserved so synthetic
  // results land in the same order the calls were issued.
  const unanswered = new Map<string, string>()

  const flushSyntheticResults = (): void => {
    for (const [toolCallId] of unanswered) {
      out.push({
        role: 'tool',
        toolCallId,
        output: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR },
      })
    }
    unanswered.clear()
  }

  for (const rec of records) {
    if (rec.role === 'user') {
      // Close any open assistant run first: a real user turn cannot follow an
      // unanswered tool_use. Synthetic results are emitted as a `tool` run that
      // the Anthropic driver then merges into this user turn.
      flushSyntheticResults()
      // `rec.content` is already validated `AiContentBlock[]` at the store read
      // boundary (`parseContentBlocks`), so no cast is needed here.
      out.push({ role: 'user', content: rec.content })
    } else if (rec.role === 'assistant') {
      const content = rec.content
      out.push({ role: 'assistant', content })
      for (const block of content) {
        if (block.kind === 'toolCall') unanswered.set(block.toolCallId, block.toolName)
      }
    } else if (rec.role === 'tool' && rec.toolCallId) {
      if (!unanswered.has(rec.toolCallId)) continue
      unanswered.delete(rec.toolCallId)
      // The outcome lives in a first-class `toolResult` block (validated at the
      // store boundary), so `ok`/`error` are read directly — never inferred from
      // an empty text block. A `role:'tool'` row with no `toolResult` block is a
      // malformed/legacy row; treat it as a failure so the model never sees a
      // silently-"succeeded" call with no data behind it.
      const resultBlock = rec.content.find((b) => b.kind === 'toolResult')
      const output: AiToolOutput =
        resultBlock?.kind === 'toolResult'
          ? { ok: resultBlock.ok, error: resultBlock.ok ? undefined : resultBlock.error }
          : { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR }
      out.push({ role: 'tool', toolCallId: rec.toolCallId, output })
    }
  }

  // Trailing assistant run whose tool calls were never answered — the exact
  // shape an aborted turn leaves behind.
  flushSyntheticResults()

  return out
}
