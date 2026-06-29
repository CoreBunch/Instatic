import { describe, test, expect, afterEach } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import {
  ResponsesTurnTranslator,
  mapResponsesHistory,
  joinInstructions,
  type ResponsesInputItem,
  type ResponsesTurn,
} from '../../../server/ai/drivers/responses-shared'
import { openaiDriver } from '../../../server/ai/drivers/openai'
import { openrouterDriver } from '../../../server/ai/drivers/openrouter'
import type { AiStreamRequest } from '../../../server/ai/drivers/types'
import type { AiMessage, AiBrowserBridge, AiStreamEvent, AiTool, AiToolOutput } from '../../../server/ai/runtime/types'
import type { SseFrame } from '../../../server/ai/drivers/http/sse'

function frame(obj: unknown): SseFrame {
  return { event: null, data: JSON.stringify(obj) }
}

describe('Responses SSE translate', () => {
  test('streams text deltas and builds an assistant message turn', () => {
    const t = new ResponsesTurnTranslator()
    expect(t.translate(frame({ type: 'response.output_text.delta', delta: 'Hello' }))).toEqual([
      { type: 'text', text: 'Hello' },
    ])
    expect(t.translate(frame({ type: 'response.output_text.delta', delta: ' world' }))).toEqual([
      { type: 'text', text: ' world' },
    ])
    t.translate(
      frame({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 8 } } }),
    )

    const result = t.finish()
    expect(result.stop).toBe(true)
    expect(result.toolCalls).toEqual([])
    expect(result.assistantMessage).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello world' }] },
    ])
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      cacheReadTokens: undefined,
      costUsd: undefined,
    })
  })

  test('emits a toolCall from a function_call output item and does not stop', () => {
    const t = new ResponsesTurnTranslator()
    const events = t.translate(
      frame({
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_1', name: 'site_insert_html', arguments: '{"parentId":"root"}' },
      }),
    )
    expect(events).toEqual([
      { type: 'toolCall', toolCallId: 'call_1', toolName: 'site_insert_html', input: { parentId: 'root' }, status: 'pending' },
    ])
    t.translate(frame({ type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 } } }))

    const result = t.finish()
    expect(result.stop).toBe(false)
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'site_insert_html', input: { parentId: 'root' } }])
    // The assistant turn carries the function_call item so the next request can
    // pair the function_call_output by call_id.
    expect(result.assistantMessage).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'site_insert_html', arguments: '{"parentId":"root"}' },
    ])
  })

  test('passes through native cost and cached tokens (OpenRouter)', () => {
    const t = new ResponsesTurnTranslator()
    t.translate(
      frame({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 100, output_tokens: 40, cost: 0.0021, input_tokens_details: { cached_tokens: 64 } },
        },
      }),
    )
    const result = t.finish()
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 40, cacheReadTokens: 64, costUsd: 0.0021 })
  })

  test('surfaces a response.failed / error event', () => {
    const failed = new ResponsesTurnTranslator()
    expect(failed.translate(frame({ type: 'response.failed' }))[0]!.type).toBe('error')

    const errored = new ResponsesTurnTranslator()
    expect(errored.translate(frame({ type: 'error', message: 'bad model' }))).toEqual([
      { type: 'error', message: 'Provider error: bad model' },
    ])
  })
})

describe('Responses mapHistory', () => {
  test('pairs assistant function_call with the following function_call_output', () => {
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ kind: 'text', text: 'ok' }] },
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 'c1', toolName: 'site_insert_html', input: { a: 1 } }] },
      { role: 'tool', toolCallId: 'c1', output: { ok: true, data: { nodeIds: ['n1'] } } },
      { role: 'assistant', content: [{ kind: 'text', text: 'done' }] },
    ]
    const mapped = mapResponsesHistory(history).flat()
    expect(mapped).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'function_call', call_id: 'c1', name: 'site_insert_html', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'c1', output: '{"nodeIds":["n1"]}' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ] satisfies ResponsesTurn)
  })

  test('stringifies a failed tool result as the error text', () => {
    const history: AiMessage[] = [
      { role: 'assistant', content: [{ kind: 'toolCall', toolCallId: 'c9', toolName: 'x', input: {} }] },
      { role: 'tool', toolCallId: 'c9', output: { ok: false, error: 'boom' } },
    ]
    const mapped = mapResponsesHistory(history).flat()
    expect(mapped[1]).toEqual({ type: 'function_call_output', call_id: 'c9', output: 'boom' })
  })

  test('maps base64 image blocks to a Responses input_image data URL', () => {
    const history: AiMessage[] = [
      { role: 'user', content: [{ kind: 'image', mimeType: 'image/png', data: 'BASE64' }, { kind: 'text', text: 'look' }] },
    ]
    const mapped = mapResponsesHistory(history).flat()
    expect(mapped).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,BASE64' },
          { type: 'input_text', text: 'look' },
        ],
      },
    ])
  })
})

describe('Responses joinInstructions', () => {
  test('drops the cache boundary marker and joins the halves', () => {
    expect(joinInstructions(['PREFIX', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'SUFFIX'])).toBe('PREFIX\n\nSUFFIX')
  })

  test('returns the single element unchanged for the 1-element form', () => {
    expect(joinInstructions(['just one'])).toBe('just one')
  })
})

// ---------------------------------------------------------------------------
// Full runToolLoop round-trip through the OpenAI Responses driver.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function responsesSse(...events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
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

// Turn 1: the model issues a function_call; turn 2 finishes with text.
const RESP_TURN1 = responsesSse(
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: 'echo', arguments: '{"v":7}' } },
  { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 10 } } },
)
const RESP_TURN2 = responsesSse(
  { type: 'response.output_text.delta', delta: 'all done' },
  { type: 'response.completed', response: { usage: { input_tokens: 25, output_tokens: 5 } } },
)

describe('runToolLoop via openaiDriver (Responses)', () => {
  test('executes a tool call and replays function_call_output on the second request', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/responses')
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(requestBodies.length === 1 ? RESP_TURN1 : RESP_TURN2)
    }) as typeof fetch

    const serverCalls: unknown[] = []
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
    const bridge: AiBrowserBridge = { async callBrowser(): Promise<AiToolOutput> { return { ok: true } } }
    const req: AiStreamRequest = {
      systemPrompt: ['You are a test.'],
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
      tools: [echoTool],
      modelId: 'gpt-5.4',
      modelCapabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
      credentials: { id: 'cr', providerId: 'openai', authMode: 'apiKey', apiKey: 'sk-test', baseUrl: null },
      signal: new AbortController().signal,
      bridge,
      toolContextBase: { db: {} as never, userId: 'u1', scope: 'site', conversationId: 'c1', snapshot: {} },
    }

    const events: AiStreamEvent[] = []
    for await (const ev of openaiDriver.stream(req)) events.push(ev)

    expect(requestBodies).toHaveLength(2)
    expect(requestBodies[0]!.prompt_cache_key).toMatch(/^instatic:site:/)
    expect(requestBodies[0]!).not.toHaveProperty('prompt_cache_retention')
    expect(serverCalls).toEqual([{ v: 7 }])

    // The 2nd request body carries the function_call (so the output can pair by
    // call_id) followed by the function_call_output.
    const secondInput = requestBodies[1]!.input as ResponsesInputItem[]
    const fnCall = secondInput.find((i): i is Extract<ResponsesInputItem, { type: 'function_call' }> => i.type === 'function_call')
    const fnOut = secondInput.find((i): i is Extract<ResponsesInputItem, { type: 'function_call_output' }> => i.type === 'function_call_output')
    expect(fnCall?.call_id).toBe('call_1')
    expect(fnOut?.call_id).toBe('call_1')
    expect(JSON.parse(fnOut!.output)).toEqual({ echoed: { v: 7 } })

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('all done')
    const usage = events.find((e) => e.type === 'usage') as { promptTokens: number; completionTokens: number } | undefined
    expect(usage!.promptTokens).toBe(45)
    expect(usage!.completionTokens).toBe(15)
  })
})

describe('openrouterDriver', () => {
  test('streams through OpenRouter Responses and passes native cost through', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/responses')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test')
      requestBodies.push(JSON.parse(init.body as string))
      return sseResponse(
        responsesSse(
          { type: 'response.output_text.delta', delta: 'openrouter reply' },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 12, output_tokens: 3, cost: 0.00042 } },
          },
        ),
      )
    }) as typeof fetch

    const bridge: AiBrowserBridge = { async callBrowser(): Promise<AiToolOutput> { return { ok: true } } }
    const req: AiStreamRequest = {
      systemPrompt: ['You are a test.'],
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'go' }] }],
      tools: [],
      modelId: 'openai/gpt-5.4',
      modelCapabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
      credentials: { id: 'cr', providerId: 'openrouter', authMode: 'apiKey', apiKey: 'sk-or-test', baseUrl: null },
      signal: new AbortController().signal,
      bridge,
      toolContextBase: {
        db: {} as never,
        userId: 'u1',
        capabilities: [],
        scope: 'site',
        conversationId: 'c1',
        snapshot: {},
      },
    }

    const events: AiStreamEvent[] = []
    for await (const ev of openrouterDriver.stream(req)) events.push(ev)

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]!.model).toBe('openai/gpt-5.4')
    expect(requestBodies[0]!.stream).toBe(true)
    expect(requestBodies[0]!).not.toHaveProperty('prompt_cache_key')
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe(
      'openrouter reply',
    )
    const usage = events.find((e) => e.type === 'usage') as
      | { promptTokens: number; completionTokens: number; costUsd?: number }
      | undefined
    expect(usage).toBeDefined()
    expect(usage!.promptTokens).toBe(12)
    expect(usage!.completionTokens).toBe(3)
    expect(usage!.costUsd).toBe(0.00042)
  })

  test('lists OpenRouter models with catalogue pricing, context, and capabilities', async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/v1/models')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test')
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-5.4',
              name: 'GPT 5.4',
              architecture: { input_modalities: ['text', 'image'] },
              supported_parameters: ['tools'],
              context_length: 128_000,
              pricing: { prompt: '0.000005', completion: '0.000025' },
            },
            {
              id: 'anthropic/claude-opus-4.8',
              name: 'Claude Opus 4.8',
              architecture: { input_modalities: ['text'] },
              supported_parameters: [],
              context_length: 200_000,
              pricing: { prompt: '0.00001', completion: '0.00005' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const models = await openrouterDriver.listModels({
      id: 'cr',
      providerId: 'openrouter',
      authMode: 'apiKey',
      apiKey: 'sk-or-test',
      baseUrl: null,
    })

    expect(models).toEqual([
      {
        id: 'openai/gpt-5.4',
        label: 'GPT 5.4',
        capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
        pricing: { inputPerMTok: 5, outputPerMTok: 25 },
        contextWindow: 128_000,
      },
      {
        id: 'anthropic/claude-opus-4.8',
        label: 'Claude Opus 4.8',
        capabilities: { toolCalling: false, visionInput: false, promptCache: false, streaming: true },
        pricing: { inputPerMTok: 10, outputPerMTok: 50 },
        contextWindow: 200_000,
      },
    ])
  })
})
