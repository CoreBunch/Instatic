import { afterEach, describe, expect, it } from 'bun:test'
import type { AiBrowserBridge, AiStreamEvent } from '../runtime/types'
import { minimaxDriver } from './minimax'
import type { AiResolvedCredential, AiStreamRequest } from './types'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function creds(baseUrl: string | null, apiKey: string | null = 'sk-test'): AiResolvedCredential {
  return { id: 'c1', providerId: 'minimax', authMode: 'baseUrl', apiKey, baseUrl }
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function request(baseUrl: string, modelId = 'MiniMax-M3'): AiStreamRequest {
  const bridge: AiBrowserBridge = {
    async callBrowser() {
      return { ok: true }
    },
  }
  return {
    systemPrompt: ['You are a test.'],
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
    tools: [],
    modelId,
    modelCapabilities: minimaxDriver.capabilities(modelId),
    credentials: creds(baseUrl),
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

describe('minimax driver', () => {
  it('reports baseUrl as its only auth mode', () => {
    expect(minimaxDriver.supportedAuthModes).toEqual(['baseUrl'])
  })

  it('returns the MiniMax model catalogue when the live endpoint is reachable', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toBe('https://api.minimax.io/v1/models')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
      return new Response(JSON.stringify({
        data: [{ id: 'MiniMax-M3' }, { id: 'MiniMax-M2.7' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const models = await minimaxDriver.listModels(creds('https://api.minimax.io/v1'))
    expect(models.map((model) => model.id)).toEqual(['MiniMax-M3', 'MiniMax-M2.7'])
    expect(models[0]).toMatchObject({
      label: 'MiniMax M3',
      capabilities: {
        toolCalling: true,
        visionInput: true,
        videoInput: true,
        promptCache: false,
        streaming: true,
      },
      contextWindow: 1000000,
      pricing: {
        inputPerMTok: 0.6,
        outputPerMTok: 2.4,
        cacheReadPerMTok: 0.12,
        cacheWritePerMTok: null,
      },
    })
    expect(models[1]).toMatchObject({
      label: 'MiniMax M2.7',
      capabilities: {
        visionInput: false,
        videoInput: false,
      },
      contextWindow: 204800,
      pricing: {
        inputPerMTok: 0.3,
        outputPerMTok: 1.2,
        cacheReadPerMTok: 0.06,
        cacheWritePerMTok: 0.375,
      },
    })
  })

  it('uses the China Anthropic-compatible model endpoint and API key header', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toBe('https://api.minimaxi.com/anthropic/v1/models')
      expect(new Headers(init?.headers).get('X-Api-Key')).toBe('sk-test')
      return Response.json({ data: [{ id: 'MiniMax-M3' }] })
    }) as typeof fetch

    const models = await minimaxDriver.listModels(creds('https://api.minimaxi.com/anthropic'))
    expect(models.map((model) => model.id)).toEqual(['MiniMax-M3'])
  })

  it('returns [] when no base URL is configured', async () => {
    expect(await minimaxDriver.listModels(creds(null))).toEqual([])
  })

  it('returns [] when no API key is configured', async () => {
    expect(await minimaxDriver.listModels(creds('https://api.minimax.io/v1', null))).toEqual([])
  })

  it('reports the MiniMax M3 media input capabilities without enabling prompt cache', () => {
    expect(minimaxDriver.capabilities('MiniMax-M3')).toMatchObject({
      toolCalling: true,
      visionInput: true,
      videoInput: true,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    })
    expect(minimaxDriver.capabilities('MiniMax-M2.7')).toMatchObject({
      visionInput: false,
      videoInput: false,
    })
  })

  it('streams through the OpenAI-compatible global endpoint with adaptive M3 thinking', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.minimax.io/v1/chat/completions')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({
        model: 'MiniMax-M3',
        reasoning_split: true,
        thinking: { type: 'adaptive' },
      })
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    }) as typeof fetch

    const events: AiStreamEvent[] = []
    for await (const event of minimaxDriver.stream(request('https://api.minimax.io/v1'))) {
      events.push(event)
    }
    expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('keeps MiniMax M2.7 always-on thinking on the provider default', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ model: 'MiniMax-M2.7', reasoning_split: true })
      expect(body.thinking).toBeUndefined()
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
        '',
      ].join('\n\n'))
    }) as typeof fetch

    for await (const _event of minimaxDriver.stream(
      request('https://api.minimax.io/v1', 'MiniMax-M2.7'),
    )) {
      // Consume the stream so the request body is exercised.
    }
  })

  it('streams through the Anthropic-compatible China endpoint with bearer auth', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.minimaxi.com/anthropic/v1/messages')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk-test')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'MiniMax-M3', stream: true })
      return sseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
      ].join('\n'))
    }) as typeof fetch

    const events: AiStreamEvent[] = []
    for await (const event of minimaxDriver.stream(request('https://api.minimaxi.com/anthropic'))) {
      events.push(event)
    }
    expect(events.filter((event) => event.type === 'text')).toEqual([{ type: 'text', text: 'ok' }])
  })
})
