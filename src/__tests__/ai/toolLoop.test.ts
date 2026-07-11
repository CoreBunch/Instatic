import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import { anthropicDriver } from '../../../server/ai/drivers/anthropic'
import { PROVIDER_RETRY_IMAGE_OMITTED } from '../../../server/ai/drivers/http/toolLoop'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiBrowserBridge, AiStreamEvent, AiTool, AiToolOutput } from '../../../server/ai/runtime/types'

/**
 * Exercises the provider-agnostic tool loop end-to-end through the Anthropic
 * driver against a mocked `fetch`: turn 1 issues a server-handler tool call and
 * a browser-bridge tool call (stop_reason: tool_use); turn 2 ends with text.
 * Asserts both tools execute and the SECOND request body carries the
 * tool_result turn.
 */

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function sse(...events: unknown[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
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

// Turn 1: model calls a server tool (echo) and a browser tool (paint).
const TURN1 = sse(
  { type: 'message_start', message: { usage: { input_tokens: 20 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't_echo', name: 'echo', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"v":42}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't_paint', name: 'paint', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 15 } },
  { type: 'message_stop' },
)

// Turn 2: model finishes with text.
const TURN2 = sse(
  { type: 'message_start', message: { usage: { input_tokens: 30 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'all done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
)

function makeRequest(bridge: AiBrowserBridge, serverCalls: unknown[]): AiStreamRequest {
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
  const paintTool: AiTool = {
    name: 'paint',
    description: 'a browser tool',
    scope: 'site',
    execution: 'browser',
    inputSchema: Type.Object({}),
  }
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
    tools: [echoTool, paintTool],
    modelId: 'claude-sonnet-4-6',
    modelCapabilities: { toolCalling: true, visionInput: true, toolResultImages: true, promptCache: true, streaming: true },
    credentials: { id: 'cr', providerId: 'anthropic', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
    signal: new AbortController().signal,
    bridge,
    toolContextBase: {
      db: {} as never,
      userId: 'u1',
      scope: 'site',
      conversationId: 'c1',
      snapshot: {},
    },
  }
}

describe('runToolLoop via anthropicDriver', () => {
  test('executes server + browser tools and replays the tool result on the second request', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(requestBodies.length === 1 ? TURN1 : TURN2)
    }) as typeof fetch

    const browserCalls: Array<{ name: string; input: unknown }> = []
    const bridge: AiBrowserBridge = {
      async callBrowser(toolName, input): Promise<AiToolOutput> {
        browserCalls.push({ name: toolName, input })
        return { ok: true, data: { painted: true } }
      },
    }
    const serverCalls: unknown[] = []
    const req = makeRequest(bridge, serverCalls)

    const events: AiStreamEvent[] = []
    for await (const ev of anthropicDriver.stream(req)) events.push(ev)

    // Two POSTs were made — initial turn + the re-POST after tool execution.
    expect(requestBodies).toHaveLength(2)

    // Server handler ran with the re-validated input.
    expect(serverCalls).toEqual([{ v: 42 }])
    // Browser bridge ran for the browser tool.
    expect(browserCalls).toEqual([{ name: 'paint', input: {} }])

    // The 2nd request body must carry the assistant tool_use turn + the
    // tool_result user turn.
    const secondMessages = requestBodies[1]!.messages as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>
    const toolResultTurn = secondMessages.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'))
    expect(toolResultTurn).toBeDefined()
    const toolUseIds = toolResultTurn!.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id)
    expect(toolUseIds).toEqual(['t_echo', 't_paint'])

    // Canonical events: two toolCalls, two toolResults, the final text, usage.
    const toolCalls = events.filter((e) => e.type === 'toolCall')
    expect(toolCalls.map((e) => (e as { toolName: string }).toolName)).toEqual(['echo', 'paint'])
    const toolResults = events.filter((e) => e.type === 'toolResult')
    expect(toolResults.map((e) => (e as { ok: boolean }).ok)).toEqual([true, true])
    const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('all done')

    // Usage aggregates across both turns for BILLING: input 20+30=50, output 15+5=20.
    const usage = events.find((e) => e.type === 'usage') as { promptTokens: number; completionTokens: number } | undefined
    expect(usage).toBeDefined()
    expect(usage!.promptTokens).toBe(50)
    expect(usage!.completionTokens).toBe(20)

    // The live meter is driven by per-round `context` events: ONE per provider
    // round, each carrying THAT round's input (20, then 30) — NOT the running
    // sum. The meter reads the latest (30 = current context size), so it climbs
    // mid-turn and never over-counts by summing rounds.
    const contextEvents = events.filter((e) => e.type === 'context') as Array<{ promptTokens: number }>
    expect(contextEvents.map((e) => e.promptTokens)).toEqual([20, 30])
  })

  test('returns an error event (not a throw) on a non-OK HTTP status', async () => {
    globalThis.fetch = (async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as typeof fetch
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [])

    const events: AiStreamEvent[] = []
    for await (const ev of anthropicDriver.stream(req)) events.push(ev)

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
    expect((events[0] as { message: string }).message).toContain('authentication failed')
  })

  test('retries a provider overflow once with only historical images elided', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string))
      if (requestBodies.length === 1) {
        return new Response(JSON.stringify({
          error: { type: 'request_too_large', message: 'Request exceeds the context limit' },
        }), { status: 413 })
      }
      return sseResponse(TURN2)
    }) as typeof fetch

    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [])
    const image = { kind: 'image' as const, mimeType: 'image/jpeg', data: '/9j/' }
    req.messages.splice(0, req.messages.length,
      { role: 'user', content: [{ kind: 'text', text: 'Earlier turn' }, image] },
      { role: 'assistant', content: [{ kind: 'text', text: 'Earlier reply' }] },
      { role: 'user', content: [{ kind: 'text', text: 'Current turn' }, image] },
    )

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requestBodies).toHaveLength(2)
    expect(JSON.stringify(requestBodies[0]).match(/"type":"image"/g)).toHaveLength(2)
    expect(JSON.stringify(requestBodies[1]).match(/"type":"image"/g)).toHaveLength(1)
    expect(JSON.stringify(requestBodies[1])).toContain(PROVIDER_RETRY_IMAGE_OMITTED)
    expect(req.messages[0]?.content.some((block) => block.kind === 'image')).toBe(true)
    expect(events.some((event) => event.type === 'error')).toBe(false)
  })

  test('does not retry when only the current user turn contains images', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      return new Response('', { status: 413 })
    }) as typeof fetch
    const req = makeRequest({ async callBrowser() { return { ok: true } } }, [])
    req.messages[0] = {
      role: 'user',
      content: [{ kind: 'image', mimeType: 'image/jpeg', data: '/9j/' }],
    }

    const events: AiStreamEvent[] = []
    for await (const event of anthropicDriver.stream(req)) events.push(event)

    expect(requests).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('Your history is still saved')
  })
})
