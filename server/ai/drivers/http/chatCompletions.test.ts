import { describe, it, expect } from 'bun:test'
import {
  mapChatHistory,
  ChatCompletionsTurnTranslator,
  trimSlash,
  normalizeOpenAiBaseUrl,
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

  it('normalizeOpenAiBaseUrl strips trailing /v1 so it is not doubled when building the endpoint', () => {
    // With /v1 suffix — should strip it so appending /v1/... is correct.
    expect(normalizeOpenAiBaseUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai')
    expect(normalizeOpenAiBaseUrl('https://api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai')
    // Without /v1 suffix — no-op.
    expect(normalizeOpenAiBaseUrl('https://api.groq.com/openai')).toBe('https://api.groq.com/openai')
    // Ollama-style URL with no path — no-op.
    expect(normalizeOpenAiBaseUrl('http://localhost:11434')).toBe('http://localhost:11434')
    expect(normalizeOpenAiBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434')
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

  // Real OpenAI-compatible gateways (OpenCode Zen, OpenRouter, …) send explicit
  // `null` for optional per-chunk fields rather than omitting them. The chunk
  // schema must tolerate these, or `parseValue` throws, the frame is dropped,
  // and the model's entire reply silently vanishes ("no reply").
  it('still emits text when the chunk carries usage:null', () => {
    const t = new ChatCompletionsTurnTranslator()
    const events = t.translate(frame({ choices: [{ delta: { content: 'Hi' } }], usage: null }))
    expect(events).toEqual([{ type: 'text', text: 'Hi' }])
  })

  it('still emits text when delta.tool_calls is null', () => {
    const t = new ChatCompletionsTurnTranslator()
    const events = t.translate(
      frame({ choices: [{ delta: { content: 'Hi', reasoning_content: null, tool_calls: null }, finish_reason: 'stop' }], usage: null }),
    )
    expect(events).toEqual([{ type: 'text', text: 'Hi' }])
  })

  it('captures the final content of a reasoning model (content empty during reasoning, filled at the end)', () => {
    const t = new ChatCompletionsTurnTranslator()
    // Reasoning phase: content is "" (or null), answer lives in reasoning_content; tool_calls/usage are null.
    t.translate(frame({ choices: [{ delta: { content: '', reasoning_content: 'thinking…', tool_calls: null } }], usage: null }))
    t.translate(frame({ choices: [{ delta: { content: null, reasoning_content: ' more' } }], usage: null }))
    // Final answer arrives in content.
    const last = t.translate(
      frame({ choices: [{ delta: { content: 'Hello there!', tool_calls: null }, finish_reason: 'stop' }], usage: null }),
    )
    expect(last).toEqual([{ type: 'text', text: 'Hello there!' }])
    const result = t.finish()
    expect(result.stop).toBe(true)
    expect(result.assistantMessage?.[0]).toMatchObject({ role: 'assistant', content: 'Hello there!' })
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
