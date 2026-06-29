import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import {
  ChatCompletionsTurnTranslator,
  mapChatHistory,
  ollamaDriver,
  type ChatMessage,
} from '../../../server/ai/drivers/ollama'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiMessage, AiBrowserBridge, AiStreamEvent, AiTool, AiToolOutput } from '../../../server/ai/runtime/types'
import type { SseFrame } from '../../../server/ai/drivers/http/sse'

function frame(obj: unknown): SseFrame {
  return { event: null, data: JSON.stringify(obj) }
}

describe('Ollama chat/completions SSE translate', () => {
  test('streams content deltas and builds a text assistant message', () => {
    const t = new ChatCompletionsTurnTranslator()
    expect(t.translate(frame({ choices: [{ delta: { content: 'Hel' } }] }))).toEqual([{ type: 'text', text: 'Hel' }])
    expect(t.translate(frame({ choices: [{ delta: { content: 'lo' } }] }))).toEqual([{ type: 'text', text: 'lo' }])
    t.translate(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    t.translate(frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }))

    const result = t.finish()
    expect(result.stop).toBe(true)
    expect(result.toolCalls).toEqual([])
    expect(result.assistantMessage).toEqual([{ role: 'assistant', content: 'Hello' }])
    expect(result.usage).toEqual({ promptTokens: 9, completionTokens: 4 })
  })

  test('accumulates a tool call from split argument fragments and emits one toolCall on finish', () => {
    const t = new ChatCompletionsTurnTranslator()
    t.translate(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'site_insert_html', arguments: '{"parent' } }] } }] }))
    expect(t.translate(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Id":"root"}' } }] } }] }))).toEqual([])
    const events = t.translate(frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }))
    expect(events).toEqual([
      { type: 'toolCall', toolCallId: 'call_a', toolName: 'site_insert_html', input: { parentId: 'root' }, status: 'pending' },
    ])

    const result = t.finish()
    expect(result.stop).toBe(false)
    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'site_insert_html', input: { parentId: 'root' } }])
    expect(result.assistantMessage).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'site_insert_html', arguments: '{"parentId":"root"}' } }],
      },
    ])
  })
})

describe('Ollama mapChatHistory', () => {
  test('prepends the system prompt and pairs tool calls with tool results', () => {
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 'c1', toolName: 'x', input: { a: 1 } }] },
      { role: 'tool', toolCallId: 'c1', output: { ok: true, data: { done: true } } },
    ]
    const mapped = mapChatHistory(['SYS'], history).flat()
    expect(mapped).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"done":true}' },
    ] satisfies ChatMessage[])
  })

  test('maps an image-bearing user turn to OpenAI content parts', () => {
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'image', mimeType: 'image/png', data: 'B64' }, { kind: 'text', text: 'see' }] },
    ]
    const mapped = mapChatHistory([], history).flat()
    expect(mapped).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,B64' } },
          { type: 'text', text: 'see' },
        ],
      },
    ])
  })
})

// ---------------------------------------------------------------------------
// Full runToolLoop round-trip through the Ollama driver with a mocked fetch.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function sse(...chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

function sseResponse(body: string): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(body))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

// Turn 1: the model calls a server tool, then stops with finish_reason tool_calls.
const TURN1 = sse(
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'echo', arguments: '{"v":7}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
)

// Turn 2: the model finishes with text.
const TURN2 = sse(
  { choices: [{ delta: { content: 'all done' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 25, completion_tokens: 5 } },
)

function makeRequest(serverCalls: unknown[]): AiStreamRequest {
  const echoTool: AiTool = {
    name: 'echo',
    description: 'echoes its input',
    scope: 'site',
    execution: 'server',
    inputSchema: Type.Object({ v: Type.Optional(Type.Number()) }),
    async handler(input) {
      serverCalls.push(input)
      return { echoed: input }
    },
  }
  const bridge: AiBrowserBridge = {
    async callBrowser(): Promise<AiToolOutput> {
      return { ok: true }
    },
  }
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
    tools: [echoTool],
    modelId: 'llama3.3',
    modelCapabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
    credentials: { id: 'cr', providerId: 'ollama', authMode: 'baseUrl', apiKey: null, baseUrl: 'http://localhost:11434' },
    signal: new AbortController().signal,
    bridge,
    toolContextBase: { db: {} as never, userId: 'u1', scope: 'site', conversationId: 'c1', snapshot: {} },
  }
}

describe('runToolLoop via ollamaDriver', () => {
  test('executes a tool call and replays the tool result on the second request', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('http://localhost:11434/v1/chat/completions')
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(requestBodies.length === 1 ? TURN1 : TURN2)
    }) as typeof fetch

    const serverCalls: unknown[] = []
    const req = makeRequest(serverCalls)

    const events: AiStreamEvent[] = []
    for await (const ev of ollamaDriver.stream(req)) events.push(ev)

    expect(requestBodies).toHaveLength(2)
    expect(serverCalls).toEqual([{ v: 7 }])

    // The 2nd request body must carry the assistant tool_calls message + the
    // tool-result message paired by tool_call_id.
    const secondMessages = requestBodies[1]!.messages as ChatMessage[]
    const toolMsg = secondMessages.find((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_call_id).toBe('call_1')
    expect(JSON.parse(toolMsg!.content)).toEqual({ echoed: { v: 7 } })
    const assistantMsg = secondMessages.find(
      (m): m is Extract<ChatMessage, { role: 'assistant' }> => m.role === 'assistant' && Boolean(m.tool_calls),
    )
    expect(assistantMsg!.tool_calls![0]!.id).toBe('call_1')

    // Canonical events: one toolCall, one toolResult, final text, aggregated usage.
    expect(events.filter((e) => e.type === 'toolCall').map((e) => (e as { toolName: string }).toolName)).toEqual(['echo'])
    expect(events.filter((e) => e.type === 'toolResult').map((e) => (e as { ok: boolean }).ok)).toEqual([true])
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('all done')

    const usage = events.find((e) => e.type === 'usage') as { promptTokens: number; completionTokens: number } | undefined
    expect(usage).toBeDefined()
    expect(usage!.promptTokens).toBe(45)
    expect(usage!.completionTokens).toBe(15)
  })
})
