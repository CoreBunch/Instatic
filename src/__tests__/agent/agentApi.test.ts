import { describe, expect, it } from 'bun:test'
import { INTERRUPTED_TOOL_RESULT_ERROR } from '@core/ai'
import type { ConversationDetail } from '@admin/ai/api'
import { rehydrateMessages, type AgentMessage, type AgentToolCall } from '@site/agent'

type PersistedMessage = ConversationDetail['messages'][number]

function message(
  id: string,
  role: PersistedMessage['role'],
  content: PersistedMessage['content'],
  toolCallId: string | null = null,
  toolName: string | null = null,
): PersistedMessage {
  return {
    id,
    position: 0,
    role,
    content,
    toolCallId,
    toolName,
    createdAt: '2026-07-11T10:00:00.000Z',
  }
}

function toolCalls(messages: AgentMessage[]): AgentToolCall[] {
  return messages.flatMap((entry) => entry.blocks.flatMap((block) =>
    block.kind === 'toolCall' ? [block.toolCall] : [],
  ))
}

describe('rehydrateMessages — persisted tool recovery', () => {
  it('keeps completed results and finalizes an unanswered screenshot as interrupted', () => {
    const messages = rehydrateMessages([
      message('user-1', 'user', [{ kind: 'text', text: 'Check both breakpoints.' }]),
      message(
        'assistant-complete',
        'assistant',
        [{
          kind: 'toolCall',
          toolCallId: 'snapshot-complete',
          toolName: 'site_render_snapshot',
          input: { breakpointId: 'mobile' },
        }],
        'snapshot-complete',
        'site_render_snapshot',
      ),
      message(
        'result-complete',
        'tool',
        [{ kind: 'toolResult', ok: true }],
        'snapshot-complete',
        'site_render_snapshot',
      ),
      message(
        'assistant-interrupted',
        'assistant',
        [{
          kind: 'toolCall',
          toolCallId: 'snapshot-interrupted',
          toolName: 'site_render_snapshot',
          input: { breakpointId: 'desktop' },
        }],
        'snapshot-interrupted',
        'site_render_snapshot',
      ),
    ])

    const [completed, interrupted] = toolCalls(messages)
    expect(completed).toMatchObject({
      externalId: 'snapshot-complete',
      actionType: 'site_render_snapshot',
      params: { breakpointId: 'mobile' },
      status: 'success',
      result: { ok: true },
    })
    expect(completed?.previewImages).toBeUndefined()
    expect(interrupted).toMatchObject({
      externalId: 'snapshot-interrupted',
      actionType: 'site_render_snapshot',
      params: { breakpointId: 'desktop' },
      status: 'error',
      result: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR },
    })
    expect(interrupted?.previewImages).toBeUndefined()
    expect(toolCalls(messages).some((toolCall) => toolCall.status === 'pending')).toBe(false)
  })

  it('finalizes malformed matching results and ignores orphan tool rows', () => {
    const messages = rehydrateMessages([
      message(
        'assistant-1',
        'assistant',
        [{
          kind: 'toolCall',
          toolCallId: 'snapshot-malformed',
          toolName: 'site_render_snapshot',
          input: ['invalid', 'params'],
        }],
        'snapshot-malformed',
        'site_render_snapshot',
      ),
      // A role:tool row without a first-class result block is malformed. It
      // must terminate the historical call rather than leave it running.
      message(
        'malformed-result',
        'tool',
        [{ kind: 'text', text: 'legacy result' }],
        'snapshot-malformed',
        'site_render_snapshot',
      ),
      // Missing ids and unmatched ids are ignored, never rendered as empty
      // assistant messages.
      message('missing-id-result', 'tool', [{ kind: 'toolResult', ok: true }]),
      message(
        'orphan-result',
        'tool',
        [{ kind: 'toolResult', ok: true }],
        'unknown-call',
        'site_render_snapshot',
      ),
    ])

    expect(messages).toHaveLength(1)
    expect(toolCalls(messages)[0]).toMatchObject({
      params: {},
      status: 'error',
      result: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR },
    })
  })

  it('does not let a late result after the next user turn resurrect an interrupted call', () => {
    const messages = rehydrateMessages([
      message(
        'assistant-1',
        'assistant',
        [{
          kind: 'toolCall',
          toolCallId: 'snapshot-late',
          toolName: 'site_render_snapshot',
          input: {},
        }],
        'snapshot-late',
        'site_render_snapshot',
      ),
      message('user-next', 'user', [{ kind: 'text', text: 'Try again.' }]),
      message(
        'late-result',
        'tool',
        [{ kind: 'toolResult', ok: true }],
        'snapshot-late',
        'site_render_snapshot',
      ),
    ])

    expect(toolCalls(messages)[0]).toMatchObject({
      status: 'error',
      result: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR },
    })
    expect(messages.map((entry) => entry.role)).toEqual(['assistant', 'user'])
  })
})
