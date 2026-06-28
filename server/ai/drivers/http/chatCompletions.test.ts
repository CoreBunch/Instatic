import { describe, it, expect } from 'bun:test'
import {
  mapChatHistory,
  ChatCompletionsTurnTranslator,
  trimSlash,
} from './chatCompletions'
import type { SseFrame } from './sse'

function frame(obj: unknown): SseFrame {
  return { event: null, data: JSON.stringify(obj) }
}

describe('chatCompletions shared adapter', () => {
  it('trimSlash strips trailing slashes', () => {
    expect(trimSlash('http://x/v1/')).toBe('http://x/v1')
    expect(trimSlash('http://x/v1')).toBe('http://x/v1')
  })

  it('mapChatHistory prepends the system prompt as a system message', () => {
    const turns = mapChatHistory(['be terse'], [
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
    ])
    expect(turns[0]).toEqual([{ role: 'system', content: 'be terse' }])
    expect(turns[1]).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('translator accumulates streamed text and finishes with stop=true when no tool calls', () => {
    const t = new ChatCompletionsTurnTranslator()
    const events = t.translate(frame({ choices: [{ delta: { content: 'Hello' } }] }))
    expect(events).toEqual([{ type: 'text', text: 'Hello' }])
    const result = t.finish()
    expect(result.stop).toBe(true)
    expect(result.toolCalls).toEqual([])
  })

  it('translator emits one toolCall event per accumulated call at finish_reason', () => {
    const t = new ChatCompletionsTurnTranslator()
    t.translate(frame({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'c1', function: { name: 'insertHtml', arguments: '{"ht' } },
    ] } }] }))
    const ev = t.translate(frame({ choices: [{ delta: { tool_calls: [
      { index: 0, function: { arguments: 'ml":"<p/>"}' } },
    ] }, finish_reason: 'tool_calls' }] }))
    const toolEvent = ev.find((e) => e.type === 'toolCall')
    expect(toolEvent).toBeTruthy()
    expect(toolEvent).toMatchObject({ type: 'toolCall', toolName: 'insertHtml', toolCallId: 'c1' })
    const result = t.finish()
    expect(result.stop).toBe(false)
    expect(result.toolCalls[0]).toMatchObject({ name: 'insertHtml' })
  })
})
