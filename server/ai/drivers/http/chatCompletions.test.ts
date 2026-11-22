import { describe, it, expect } from 'bun:test'
import {
  mapChatHistory,
  sanitizeToolPairing,
  makeChatCompletionsAdapter,
  UNANSWERED_TOOL_CALL_RESULT,
  ChatCompletionsTurnTranslator,
  trimSlash,
  normalizeOpenAiBaseUrl,
  type ChatMessage,
} from './chatCompletions'
import type { AiStreamRequest } from '../types'
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

// ---------------------------------------------------------------------------
// DeepSeek-strict tool pairing
// ---------------------------------------------------------------------------

function call(id: string): NonNullable<Extract<ChatMessage, { role: 'assistant' }>['tool_calls']>[number] {
  return { id, type: 'function', function: { name: 'site_insert_node', arguments: '{}' } }
}

function assistantCalls(ids: string[]): ChatMessage {
  return { role: 'assistant', content: '', tool_calls: ids.map(call) }
}

function toolResult(id: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, content: '{"ok":true}' }
}

/**
 * The exact check DeepSeek runs server-side, which returns 400 Invalid Format:
 * "An assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'". Throws with the offending index so a
 * failure points at the message instead of a bare boolean.
 */
function assertStrictToolPairing(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role !== 'assistant' || !message.tool_calls || message.tool_calls.length === 0) continue
    const declared = message.tool_calls.map((c) => c.id)
    const answered: string[] = []
    let j = i + 1
    while (j < messages.length && messages[j]!.role === 'tool') {
      answered.push((messages[j]! as Extract<ChatMessage, { role: 'tool' }>).tool_call_id)
      j += 1
    }
    expect({ index: i, answered: answered.slice().sort() }).toEqual({
      index: i,
      answered: declared.slice().sort(),
    })
  }
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    if (message.role !== 'tool') continue
    let k = i - 1
    while (k >= 0 && messages[k]!.role === 'tool') k -= 1
    const owner = messages[k]
    expect({ index: i, owner: owner?.role }).toEqual({ index: i, owner: 'assistant' })
    const declaredIds =
      owner && owner.role === 'assistant' ? (owner.tool_calls ?? []).map((c) => c.id) : []
    expect({ index: i, declared: declaredIds.includes(message.tool_call_id) }).toEqual({
      index: i,
      declared: true,
    })
  }
  // DeepSeek also rejects successive same-role messages — but only for
  // user/assistant turns: several consecutive `tool` results are the required
  // shape for a parallel batch.
  for (let i = 1; i < messages.length; i += 1) {
    const a = messages[i - 1]!
    const b = messages[i]!
    if (a.role === 'tool' || b.role === 'tool') continue
    expect({ index: i, sameRoleAsPrevious: b.role === a.role }).toEqual({
      index: i,
      sameRoleAsPrevious: false,
    })
  }
}

describe('sanitizeToolPairing (DeepSeek strictness)', () => {
  it('answers a single unanswered tool call with a synthetic result', () => {
    const healed = sanitizeToolPairing([
      { role: 'user', content: 'edit the page' },
      assistantCalls(['call_1']),
    ])
    expect(healed).toEqual([
      { role: 'user', content: 'edit the page' },
      assistantCalls(['call_1']),
      { role: 'tool', tool_call_id: 'call_1', content: UNANSWERED_TOOL_CALL_RESULT },
    ])
    assertStrictToolPairing(healed)
  })

  it('answers only the missing calls when a parallel batch was half-executed', () => {
    const healed = sanitizeToolPairing([
      { role: 'user', content: 'build a landing page' },
      assistantCalls(['call_a', 'call_b', 'call_c']),
      toolResult('call_a'),
      { role: 'user', content: 'continue' },
    ])
    // The real result stays put; the two stragglers are answered right after
    // it, before the user turn that would otherwise orphan the whole run.
    expect(healed.slice(2, 5)).toEqual([
      toolResult('call_a'),
      { role: 'tool', tool_call_id: 'call_b', content: UNANSWERED_TOOL_CALL_RESULT },
      { role: 'tool', tool_call_id: 'call_c', content: UNANSWERED_TOOL_CALL_RESULT },
    ])
    expect(healed.at(-1)).toEqual({ role: 'user', content: 'continue' })
    assertStrictToolPairing(healed)
  })

  it('drops a tool result whose call was never declared', () => {
    const healed = sanitizeToolPairing([
      { role: 'user', content: 'hi' },
      toolResult('ghost'),
      { role: 'assistant', content: 'done' },
    ])
    expect(healed).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'done' },
    ])
    assertStrictToolPairing(healed)
  })

  it('collapses duplicate call ids within one assistant turn', () => {
    const healed = sanitizeToolPairing([assistantCalls(['dup', 'dup']), toolResult('dup')])
    const first = healed[0] as Extract<ChatMessage, { role: 'assistant' }>
    expect(first.tool_calls).toHaveLength(1)
    expect(healed[1]).toEqual(toolResult('dup'))
    assertStrictToolPairing(healed)
  })

  it('leaves an already-valid history byte-identical', () => {
    const valid: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      assistantCalls(['c1', 'c2']),
      toolResult('c1'),
      toolResult('c2'),
      { role: 'assistant', content: 'finished' },
    ]
    expect(sanitizeToolPairing(valid)).toEqual(valid)
    assertStrictToolPairing(sanitizeToolPairing(valid))
  })

  it('merges adjacent user messages (an aborted bootstrap leaves two)', () => {
    const merged = sanitizeToolPairing([
      { role: 'user', content: 'build a landing page' },
      { role: 'user', content: 'actually, a pricing page' },
    ])
    expect(merged).toEqual([{ role: 'user', content: 'build a landing page\n\nactually, a pricing page' }])
    assertStrictToolPairing(merged)
  })

  it('merges adjacent user messages without flattening image parts', () => {
    const merged = sanitizeToolPairing([
      { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] },
      { role: 'user', content: 'and make it bigger' },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        { type: 'text', text: 'and make it bigger' },
      ],
    })
  })

  it('merges a text-only assistant turn into the following tool-calling turn', () => {
    const merged = sanitizeToolPairing([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Editing the hero.' },
      { role: 'assistant', content: 'Now the header.', tool_calls: [call('c1')] },
      toolResult('c1'),
    ])
    expect(merged).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Editing the hero.\n\nNow the header.', tool_calls: [call('c1')] },
      toolResult('c1'),
    ])
    assertStrictToolPairing(merged)
  })

  it('repairs the request body the adapter actually sends', () => {
    const adapter = makeChatCompletionsAdapter({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      label: 'Custom Provider',
    })
    const body = adapter.buildRequestBody([[assistantCalls(['orphaned'])]], {
      modelId: 'deepseek-chat',
      tools: [],
    } as unknown as AiStreamRequest) as { messages: ChatMessage[] }
    assertStrictToolPairing(body.messages)
    expect(body.messages).toHaveLength(2)
  })
})
