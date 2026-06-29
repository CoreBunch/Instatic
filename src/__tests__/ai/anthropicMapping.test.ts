import { describe, test, expect } from 'bun:test'
import {
  AnthropicTurnTranslator,
  buildSystemBlocks,
  mapHistory,
  type AnthropicMessage,
} from '../../../server/ai/drivers/anthropic'
import type { AiMessage } from '../../../server/ai/runtime/types'
import type { SseFrame } from '../../../server/ai/drivers/http/sse'

function frame(obj: unknown): SseFrame {
  return { event: null, data: JSON.stringify(obj) }
}

describe('Anthropic SSE translate', () => {
  test('streams text deltas and builds a text assistant turn', () => {
    const t = new AnthropicTurnTranslator()
    expect(t.translate(frame({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 4 } } }))).toEqual([])
    expect(t.translate(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))).toEqual([])
    expect(t.translate(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }))).toEqual([
      { type: 'text', text: 'Hello' },
    ])
    expect(t.translate(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } }))).toEqual([
      { type: 'text', text: ' world' },
    ])
    expect(t.translate(frame({ type: 'content_block_stop', index: 0 }))).toEqual([])
    expect(t.translate(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }))).toEqual([])

    const result = t.finish()
    expect(result.stop).toBe(true)
    expect(result.toolCalls).toEqual([])
    expect(result.assistantMessage).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] })
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 7, cacheReadTokens: 4, cacheCreationTokens: 0 })
  })

  test('accumulates a tool_use block from split input_json_delta and emits one toolCall', () => {
    const t = new AnthropicTurnTranslator()
    t.translate(frame({ type: 'message_start', message: { usage: { input_tokens: 5 } } }))
    t.translate(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'site_insert_html', input: {} } }))
    t.translate(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"parentId":' } }))
    t.translate(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"root"}' } }))
    const events = t.translate(frame({ type: 'content_block_stop', index: 0 }))
    expect(events).toEqual([
      { type: 'toolCall', toolCallId: 'toolu_1', toolName: 'site_insert_html', input: { parentId: 'root' }, status: 'pending' },
    ])
    t.translate(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }))

    const result = t.finish()
    expect(result.stop).toBe(false)
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'site_insert_html', input: { parentId: 'root' } }])
    expect(result.assistantMessage).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'site_insert_html', input: { parentId: 'root' } }],
    })
  })

  test('surfaces an error SSE event', () => {
    const t = new AnthropicTurnTranslator()
    const events = t.translate(frame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
    expect(events).toEqual([{ type: 'error', message: 'Anthropic error: Overloaded' }])
  })
})

describe('Anthropic mapHistory', () => {
  test('pairs assistant tool_use with the following tool result into a user turn', () => {
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 't1', toolName: 'site_insert_html', input: { a: 1 } }] },
      { role: 'tool', toolCallId: 't1', output: { ok: true, data: { nodeIds: ['n1'] } } },
      { role: 'assistant', content: [{ kind: 'text', text: 'done' }] },
    ]
    const mapped = mapHistory(history)
    expect(mapped).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 't1', name: 'site_insert_html', input: { a: 1 } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"nodeIds":["n1"]}', is_error: undefined }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] satisfies AnthropicMessage[])
  })

  test('marks a failed tool result with is_error', () => {
    const history: AiMessage[] = [
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 't9', toolName: 'x', input: {} }] },
      { role: 'tool', toolCallId: 't9', output: { ok: false, error: 'boom' } },
    ]
    const mapped = mapHistory(history)
    const toolTurn = mapped[1]!
    expect(toolTurn.role).toBe('user')
    expect(toolTurn.content[0]).toEqual({ type: 'tool_result', tool_use_id: 't9', content: 'boom', is_error: true })
  })

  test('coalesces a synthetic tool-result user turn with the following user prompt', () => {
    // The shape buildMessageHistory produces after healing an aborted turn:
    // an orphaned tool_use, its synthetic error result, then a new user prompt.
    // These must collapse into one user turn so Anthropic sees strict
    // user/assistant alternation with the tool_use answered.
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 't1', toolName: 'site_apply_css', input: {} }] },
      { role: 'tool', toolCallId: 't1', output: { ok: false, error: 'interrupted' } },
      { role: 'user', content: [{ kind: 'text', text: 'next prompt' }] },
    ]
    const mapped = mapHistory(history)
    expect(mapped).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'site_apply_css', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'interrupted', is_error: true },
          { type: 'text', text: 'next prompt' },
        ],
      },
    ] satisfies AnthropicMessage[])
    // Roles strictly alternate — no two adjacent user turns.
    for (let i = 1; i < mapped.length; i++) {
      expect(mapped[i]!.role).not.toBe(mapped[i - 1]!.role)
    }
  })

  test('maps base64 image blocks to Anthropic image source', () => {
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'image', mimeType: 'image/png', data: 'BASE64' }, { kind: 'text', text: 'look' }] },
    ]
    const mapped = mapHistory(history)
    expect(mapped).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64' } },
          { type: 'text', text: 'look' },
        ],
      },
    ])
  })
})

describe('Anthropic buildSystemBlocks', () => {
  test('maps the 3-element cached form to two blocks with cache_control on the prefix', () => {
    const blocks = buildSystemBlocks(['PREFIX', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'SUFFIX'])
    expect(blocks).toEqual([
      { type: 'text', text: 'PREFIX', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'SUFFIX' },
    ])
  })

  test('returns a single string for the 1-element form', () => {
    expect(buildSystemBlocks(['just one'])).toBe('just one')
  })
})
