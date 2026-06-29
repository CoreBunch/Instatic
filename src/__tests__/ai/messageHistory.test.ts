import { describe, test, expect } from 'bun:test'
import {
  buildMessageHistory,
  INTERRUPTED_TOOL_RESULT_ERROR,
} from '../../../server/ai/conversations/history'
import type { MessageRecord } from '../../../server/ai/conversations/types'
import type { AiContentBlock } from '../../../server/ai/runtime/types'

let seq = 0
function rec(
  role: MessageRecord['role'],
  content: AiContentBlock[],
  toolCallId: string | null = null,
  toolName: string | null = null,
): MessageRecord {
  seq += 1
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    position: seq,
    role,
    content,
    toolCallId,
    toolName,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function userText(text: string): MessageRecord {
  return rec('user', [{ kind: 'text', text }])
}
function assistantToolCall(id: string, name: string, input: unknown): MessageRecord {
  return rec('assistant', [{ kind: 'toolCall', toolCallId: id, toolName: name, input }], id, name)
}
function toolResult(id: string, name: string, errorText = ''): MessageRecord {
  const block: AiContentBlock =
    errorText === ''
      ? { kind: 'toolResult', ok: true }
      : { kind: 'toolResult', ok: false, error: errorText }
  return rec('tool', [block], id, name)
}

describe('buildMessageHistory', () => {
  test('replays a completed conversation unchanged (no synthetic results)', () => {
    const history = buildMessageHistory([
      userText('hi'),
      rec('assistant', [{ kind: 'text', text: 'ok' }]),
      assistantToolCall('t1', 'site_insert_html', { a: 1 }),
      toolResult('t1', 'site_insert_html'),
      rec('assistant', [{ kind: 'text', text: 'done' }]),
    ])

    expect(history).toEqual([
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 't1', toolName: 'site_insert_html', input: { a: 1 } }] },
      { role: 'tool', toolCallId: 't1', output: { ok: true, error: undefined } },
      { role: 'assistant', content: [{ kind: 'text', text: 'done' }] },
    ])
  })

  test('synthesizes an error result for trailing orphaned tool calls (aborted turn)', () => {
    // The reported bug: 5 parallel tool_use rows persisted, stream died before
    // any result landed.
    const records = [userText('continue')]
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      records.push(assistantToolCall(id, 'site_apply_css', { sel: id }))
    }

    const history = buildMessageHistory(records)

    // Every tool_use is now answered by a synthetic error result.
    const toolMsgs = history.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(5)
    for (const m of toolMsgs) {
      expect(m).toMatchObject({ role: 'tool', output: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR } })
    }
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(5)
  })

  test('synthesizes results only for the unanswered subset (partial interruption)', () => {
    const history = buildMessageHistory([
      userText('go'),
      assistantToolCall('a', 'tool', {}),
      assistantToolCall('b', 'tool', {}),
      assistantToolCall('c', 'tool', {}),
      toolResult('a', 'tool'),
      toolResult('b', 'tool'),
    ])

    const toolMsgs = history.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(3)
    // a, b real (ok); c synthesized (error)
    const byId = Object.fromEntries(
      toolMsgs.map((m) => [(m as { toolCallId: string }).toolCallId, m]),
    )
    expect(byId['a']).toMatchObject({ output: { ok: true } })
    expect(byId['b']).toMatchObject({ output: { ok: true } })
    expect(byId['c']).toMatchObject({ output: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR } })
  })

  test('inserts synthetic results before a following user turn', () => {
    // Orphaned tool_use from an aborted turn, then the user sends a new prompt.
    const history = buildMessageHistory([
      userText('continue'),
      assistantToolCall('a', 'tool', {}),
      userText('next prompt'),
    ])

    expect(history).toEqual([
      { role: 'user', content: [{ kind: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 'a', toolName: 'tool', input: {} }] },
      { role: 'tool', toolCallId: 'a', output: { ok: false, error: INTERRUPTED_TOOL_RESULT_ERROR } },
      { role: 'user', content: [{ kind: 'text', text: 'next prompt' }] },
    ])
  })

  test('preserves a persisted error tool result as an error', () => {
    const history = buildMessageHistory([
      assistantToolCall('t1', 'x', {}),
      toolResult('t1', 'x', 'boom'),
    ])
    expect(history[1]).toEqual({
      role: 'tool',
      toolCallId: 't1',
      output: { ok: false, error: 'boom' },
    })
  })
})
