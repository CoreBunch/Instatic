import { describe, it, expect, afterEach } from 'bun:test'
import { requestyDriver } from './requesty'
import type { AiResolvedCredential } from './types'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function creds(apiKey: string | null): AiResolvedCredential {
  return { id: 'c1', providerId: 'requesty', authMode: 'apiKey', apiKey, baseUrl: null }
}

describe('requesty driver', () => {
  it('reports apiKey as its only auth mode', () => {
    expect(requestyDriver.supportedAuthModes).toEqual(['apiKey'])
  })

  it('capabilities default to tool-calling + streaming', () => {
    expect(requestyDriver.capabilities('anything')).toMatchObject({ toolCalling: true, streaming: true })
  })

  it('listModels hits the Requesty /v1/models catalogue with the bearer', async () => {
    let seenUrl = ''
    let seenAuth: string | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url)
      const headers = new Headers(init?.headers)
      seenAuth = headers.get('authorization')
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await requestyDriver.listModels(creds('rqsty-sk-test'))
    expect(seenUrl).toBe('https://router.requesty.ai/v1/models')
    expect(seenAuth).toBe('Bearer rqsty-sk-test')
  })

  it('listModels maps Requesty capability booleans, prices, and context window', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'openai/gpt-4o-mini',
              api: 'chat',
              description: 'GPT-4o mini',
              context_window: 128000,
              supports_tool_calling: true,
              supports_vision: true,
              supports_caching: true,
              // per-token USD floats — the picker shows per-million.
              input_price: 1.5e-7,
              output_price: 6e-7,
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const models = await requestyDriver.listModels(creds('rqsty-sk-test'))
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'openai/gpt-4o-mini',
      label: 'GPT-4o mini',
      capabilities: {
        toolCalling: true,
        visionInput: true,
        promptCache: true,
        streaming: true,
      },
      // 1.5e-7 * 1e6 = 0.15 ; 6e-7 * 1e6 = 0.6
      pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
      contextWindow: 128000,
    })
  })

  it('listModels drops non-chat catalogue entries (e.g. embeddings)', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-4o-mini', api: 'chat' },
            { id: 'openai/text-embedding-3-small', api: 'embedding' },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const models = await requestyDriver.listModels(creds('rqsty-sk-test'))
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-4o-mini'])
  })

  it('listModels defaults tool-calling on when the catalogue omits the flag', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'some/model' }] }), { status: 200 })) as unknown as typeof fetch

    const models = await requestyDriver.listModels(creds('rqsty-sk-test'))
    expect(models[0]).toMatchObject({
      id: 'some/model',
      label: 'some/model',
      capabilities: { toolCalling: true, visionInput: false, promptCache: false, streaming: true },
    })
    // No price/context published → those fields are omitted.
    expect(models[0]).not.toHaveProperty('pricing')
    expect(models[0]).not.toHaveProperty('contextWindow')
  })

  it('listModels throws on a non-OK catalogue response', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500, statusText: 'Server Error' })) as unknown as typeof fetch
    await expect(requestyDriver.listModels(creds('rqsty-sk-test'))).rejects.toThrow(/models request failed/)
  })

  it('stream yields a clean error when no API key is present', async () => {
    const events = []
    for await (const ev of requestyDriver.stream({
      credentials: creds(null),
      modelId: 'openai/gpt-4o-mini',
      systemPrompt: [],
      messages: [],
      tools: [],
    } as never)) {
      events.push(ev)
    }
    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('Requesty requires an API key') },
    ])
  })
})
