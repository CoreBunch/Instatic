import { describe, test, expect } from 'bun:test'
import {
  createTranslateState,
  translateLine,
  type TranslateState,
} from '../../../server/ai/drivers/claudeCodeEvents'
import type { AiStreamEvent } from '../../../server/ai/runtime/types'

function feed(state: TranslateState, ...events: unknown[]): AiStreamEvent[] {
  const out: AiStreamEvent[] = []
  for (const e of events) out.push(...translateLine(JSON.stringify(e), state))
  return out
}

const INIT_WITH_TOOLS = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  tools: ['mcp__instatic__get_context', 'mcp__instatic__site_get_tree'],
  mcp_servers: [{ name: 'instatic', status: 'pending' }],
}

describe('Claude Code stream-json translate', () => {
  test('streams text deltas from the nested Anthropic event', () => {
    const state = createTranslateState()
    const events = feed(
      state,
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } },
    )
    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
    ])
    expect(state.sawText).toBe(true)
  })

  test('thinking deltas produce no chat output', () => {
    const state = createTranslateState()
    const events = feed(state, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    expect(events).toEqual([])
    expect(state.sawText).toBe(false)
  })

  test('emits a toolCall per tool_use and names its result, stripping the mcp prefix', () => {
    const state = createTranslateState()
    const calls = feed(state, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__instatic__site_get_tree', input: { a: 1 } }] },
    })
    expect(calls).toEqual([
      { type: 'toolCall', toolCallId: 'tu_1', toolName: 'site_get_tree', input: { a: 1 }, status: 'pending' },
    ])
    expect(state.toolCallCount).toBe(1)

    const results = feed(state, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] },
    })
    expect(results).toEqual([
      { type: 'toolResult', toolCallId: 'tu_1', toolName: 'site_get_tree', ok: true, error: undefined },
    ])
  })

  // The bug this driver kept hitting: with tool search on, the CLI deferred every
  // MCP tool behind a built-in that `--tools ''` strips, so the model got nothing
  // to call, narrated a tool call in prose, and ended the turn `success`.
  test('counts the CMS tools the CLI actually offered at init', () => {
    const state = createTranslateState()
    expect(feed(state, INIT_WITH_TOOLS)).toEqual([])
    expect(state.sawInit).toBe(true)
    expect(state.mcpToolCount).toBe(2)
  })

  test('a toolless init is visible as zero CMS tools', () => {
    const state = createTranslateState()
    feed(state, { type: 'system', subtype: 'init', session_id: 's1', tools: [], mcp_servers: [{ name: 'instatic', status: 'pending' }] })
    expect(state.sawInit).toBe(true)
    expect(state.mcpToolCount).toBe(0)
  })

  // The two toolless causes need different advice, and the CLI already tells us
  // which one happened.
  test('records the instatic MCP server status so the cause can be named', () => {
    const connected = createTranslateState()
    feed(connected, INIT_WITH_TOOLS)
    expect(connected.mcpServerStatus).toBe('pending')

    const failed = createTranslateState()
    feed(failed, { type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'instatic', status: 'failed' }] })
    expect(failed.mcpServerStatus).toBe('failed')
    expect(failed.mcpToolCount).toBe(0)

    const absent = createTranslateState()
    feed(absent, { type: 'system', subtype: 'init', tools: [], mcp_servers: [{ name: 'other', status: 'connected' }] })
    expect(absent.mcpServerStatus).toBeNull()
  })

  test('built-in tools do not count as CMS tools', () => {
    const state = createTranslateState()
    feed(state, { type: 'system', subtype: 'init', tools: ['Bash', 'ToolSearch'], mcp_servers: [] })
    expect(state.mcpToolCount).toBe(0)
  })

  test('an allowed rate-limit ping is not an error', () => {
    const state = createTranslateState()
    feed(state, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } })
    expect(state.rateLimitMessage).toBeNull()
  })

  test('a blocking rate limit is captured with its reset time', () => {
    const state = createTranslateState()
    feed(state, {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790661000 },
    })
    expect(state.rateLimitMessage).toContain('five_hour')
    expect(state.rateLimitMessage).toContain('rejected')
    expect(state.rateLimitMessage).toContain('2026-09-29')
  })

  test('a successful result reports usage and context', () => {
    const state = createTranslateState()
    const events = feed(state, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 10, output_tokens: 41, cache_read_input_tokens: 6330, cache_creation_input_tokens: 5 },
    })
    expect(state.resultSeen).toBe(true)
    expect(state.resultErrorMessage).toBeNull()
    expect(events).toEqual([
      { type: 'context', promptTokens: 10, cacheReadTokens: 6330, cacheCreationTokens: 5 },
      { type: 'usage', promptTokens: 10, completionTokens: 41, cacheReadTokens: 6330, cacheCreationTokens: 5 },
    ])
  })

  test('a result with no streamed text falls back to the result string', () => {
    const state = createTranslateState()
    const events = feed(state, { type: 'result', subtype: 'success', result: 'final answer' })
    expect(events).toEqual([{ type: 'text', text: 'final answer' }])
  })

  // Held rather than yielded so the caller can decide between "terminal" and
  // "recoverable session mismatch, retry as the other mode".
  test('a failing result is recorded, not emitted as a stream error', () => {
    const state = createTranslateState()
    const events = feed(state, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'gone',
    })
    expect(events).toEqual([])
    expect(state.resultSeen).toBe(true)
    expect(state.resultErrorMessage).toContain('error_during_execution')
  })

  test('unreadable lines are counted so format drift is diagnosable', () => {
    const state = createTranslateState()
    expect([...translateLine('not json at all', state)]).toEqual([])
    expect([...translateLine('{"type":', state)]).toEqual([])
    expect(state.unparseableLines).toBe(2)
  })

  test('unknown event types are ignored without counting as drift', () => {
    const state = createTranslateState()
    expect(feed(state, { type: 'some_future_event', payload: 1 })).toEqual([])
    expect(state.unparseableLines).toBe(0)
  })
})
