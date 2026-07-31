import { INTERRUPTED_TOOL_RESULT_ERROR, aiToolError } from '@core/ai'
import type { AgentMessage } from './types'

/**
 * A pending tool call belongs only to the currently live response stream.
 * Once that stream ends or fails, every unresolved call is historical and
 * must become terminal so the panel never leaves a permanent spinner behind.
 */
export function failPendingToolCalls(
  message: AgentMessage | undefined,
  error: string = INTERRUPTED_TOOL_RESULT_ERROR,
): boolean {
  if (!message) return false

  let changed = false
  for (const block of message.blocks) {
    if (block.kind !== 'toolCall' || block.toolCall.status !== 'pending') continue
    block.toolCall.status = 'error'
    block.toolCall.result = aiToolError(error)
    changed = true
  }
  return changed
}
