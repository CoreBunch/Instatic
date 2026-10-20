import { afterEach, describe, expect, it } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import type { AiStreamEvent } from '../runtime/types'
import { minimaxDriver } from './minimax'
import { openrouterDriver } from './openrouter'
import type { AiResolvedCredential, AiStreamRequest } from './types'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function creds(baseUrl: string | null, apiKey: string | null = 'test-key'): AiResolvedCredential {
  return { id: 'c1', providerId: 'minimax', authMode: 'baseUrl', apiKey, baseUrl }
}

function sse(events: object[], anthropic = false): Response {
  return new Response(events.map((event) => `${anthropic ? `event: ${'type' in event ? event.type : ''}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function request(baseUrl: string, modelId = 'MiniMax-M3.1-Flash'): AiStreamRequest {
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
    tools: [], modelId,
    modelCapabilities: minimaxDriver.capabilities(modelId),
    credentials: creds(baseUrl),
    signal: new AbortController().signal,
    bridge: { async callBrowser() { return { ok: true } } },
    toolContextBase: {
      db: {} as never, userId: 'u1', capabilities: [], scope: 'site', conversationId: 'c1', snapshot: {},
    },
  }
}

async function consume(req: AiStreamRequest): Promise<AiStreamEvent[]> {
  const events: AiStreamEvent[] = []
  for await (const event of minimaxDriver.stream(req)) events.push(event)
  expect(events.filter((event) => event.type === 'error')).toEqual([])
  return events
}

const endpoints = [
  'https://api.minimax.io/v1',
  'https://api.minimaxi.com/v1',
  'https://api.minimax.io/anthropic',
  'https://api.minimaxi.com/anthropic',
]

describe('minimax driver', () => {
  it('requires a base URL and key', async () => {
    expect(minimaxDriver.supportedAuthModes).toEqual(['baseUrl'])
    expect(await minimaxDriver.listModels(creds(null))).toEqual([])
    expect(await minimaxDriver.listModels(creds(endpoints[0]!, null))).toEqual([])
  })

  for (const baseUrl of endpoints) {
    const anthropic = baseUrl.endsWith('/anthropic')
    it(`offers only live Flash then M3 at ${baseUrl}`, async () => {
      let calledUrl = ''
      let headers = new Headers()
      globalThis.fetch = (async (input, init) => {
        calledUrl = String(input)
        headers = new Headers(init?.headers)
        return Response.json({ data: [
          { id: 'MiniMax-M2.7' }, { id: 'MiniMax-M3' }, { id: 'other' }, { id: 'MiniMax-M3.1-Flash' },
        ] })
      }) as typeof fetch
      const models = await minimaxDriver.listModels(creds(baseUrl))
      expect(calledUrl).toBe(`${baseUrl}${anthropic ? '/v1' : ''}/models`)
      expect(headers.get(anthropic ? 'X-Api-Key' : 'Authorization')).toBe(anthropic ? 'test-key' : 'Bearer test-key')
      expect(models.map((model) => model.id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
      expect(models[0]).toMatchObject({
        contextWindow: 1_000_000, catalogueSource: 'live',
        pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.015, cacheWritePerMTok: null },
        capabilities: { visionInput: true, videoInput: true },
      })
      expect(models[1]).toMatchObject({
        contextWindow: 1_000_000,
        pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2, cacheReadPerMTok: 0.06, cacheWritePerMTok: null },
      })
    })

    for (const modelId of ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'custom-saved-model']) {
      it(`serializes ${modelId} unchanged at ${baseUrl} with protocol thinking/effort defaults`, async () => {
        let calledUrl = ''
        let body: Record<string, unknown> = {}
        globalThis.fetch = (async (input, init) => {
          calledUrl = String(input)
          body = JSON.parse(String(init?.body))
          return anthropic
            ? sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }], true)
            : sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
        }) as typeof fetch
        await consume(request(baseUrl, modelId))
        expect(calledUrl).toBe(`${baseUrl}${anthropic ? '/v1/messages' : '/chat/completions'}`)
        expect(body.model).toBe(modelId)
        expect(body.stream).toBe(true)
        expect(body.thinking).toBeUndefined()
        expect(body.reasoning_effort).toBeUndefined()
        expect(body.output_config).toBeUndefined()
        expect(body.service_tier).toBeUndefined()
        if (!anthropic) expect(body.reasoning_split).toBe(true)
      })
    }

    it(`preserves reasoning, tools, prior history and images through tool continuation at ${baseUrl}`, async () => {
      const bodies: Record<string, unknown>[] = []
      globalThis.fetch = (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length > 1) return anthropic
          ? sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }], true)
          : sse([{ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }])
        return anthropic ? sse([
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Plan ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'carefully' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ], true) : sse([
          { choices: [{ delta: { reasoning_content: 'Plan ' } }] },
          { choices: [{ delta: { reasoning_content: 'carefully', content: 'Checking', tool_calls: [
            { index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{}' } },
          ] }, finish_reason: 'tool_calls' }] },
        ])
      }) as typeof fetch
      const req = request(baseUrl)
      req.messages.push(
        { role: 'assistant', content: [{ kind: 'text', text: 'Prior answer' }] },
        { role: 'user', content: [{ kind: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] },
      )
      req.tools.push({ name: 'lookup', description: 'Read a value', scope: 'shared', execution: 'server', inputSchema: Type.Object({}), async handler() { return { value: 42 } } })
      await consume(req)
      expect(bodies).toHaveLength(2)
      expect(bodies[0]!.tools).toHaveLength(1)
      const replay = JSON.stringify(bodies[1]!.messages)
      expect(replay).toContain('Prior answer')
      expect(replay).toContain('aW1hZ2U=')
      expect(replay).toContain('call-1')
      expect(replay).toContain('42')
      expect(replay).toContain('Plan carefully')
      if (anthropic) expect(replay).toContain('signature')
      else expect(replay).toContain('reasoning_content')
    })
  }

  it('does not invent availability when Flash is absent or the endpoint fails', async () => {
    globalThis.fetch = (async () => Response.json({ data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }] })) as typeof fetch
    expect((await minimaxDriver.listModels(creds(endpoints[0]!))).map((model) => model.id)).toEqual(['MiniMax-M3'])
    globalThis.fetch = (async () => new Response('', { status: 503 })) as typeof fetch
    expect(await minimaxDriver.listModels(creds(endpoints[0]!))).toEqual([])
    expect(minimaxDriver.capabilities('MiniMax-M2.7').visionInput).toBe(false)
  })
})

describe('MiniMax gateway choices', () => {
  it('filters ordinary choices while preserving gateway metadata and saved legacy capabilities', async () => {
    globalThis.fetch = (async () => Response.json({ data: [
      { id: 'unrelated/first', context_length: 123 },
      { id: 'minimax/minimax-m2.7', architecture: { input_modalities: ['text', 'image'] } },
      { id: 'minimax/minimax-m3', context_length: 1048576, pricing: { prompt: '0.0000003', completion: '0.0000012' } },
      { id: 'unrelated/last' },
      { id: 'minimax/media-fixture' },
      { id: 'minimax/minimax-m3.1-flash:free', context_length: 1000000, pricing: { prompt: '0', completion: '0' } },
    ] })) as typeof fetch
    const credential: AiResolvedCredential = { ...creds(null), providerId: 'openrouter', authMode: 'apiKey' }
    const models = await openrouterDriver.listModels(credential)
    expect(models.map((model) => model.id)).toEqual([
      'unrelated/first', 'minimax/minimax-m3.1-flash:free', 'minimax/minimax-m3', 'unrelated/last', 'minimax/media-fixture',
    ])
    expect(models[1]).toMatchObject({ contextWindow: 1000000, pricing: { inputPerMTok: 0, outputPerMTok: 0 } })
    expect(models[2]).toMatchObject({ contextWindow: 1048576, pricing: { inputPerMTok: 0.3, outputPerMTok: 1.2 } })
    expect((await openrouterDriver.resolveCapabilities!(credential, 'minimax/minimax-m2.7', new AbortController().signal)).visionInput).toBe(true)
  })
})
