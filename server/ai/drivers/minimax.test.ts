import { afterEach, describe, expect, it } from 'bun:test'
import { minimaxDriver } from './minimax'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function creds(baseUrl: string | null) {
  return { id: 'c1', providerId: 'minimax', authMode: 'baseUrl', apiKey: 'sk-test', baseUrl }
}

describe('minimax driver', () => {
  it('reports baseUrl as its only auth mode', () => {
    expect(minimaxDriver.supportedAuthModes).toEqual(['baseUrl'])
  })

  it('returns the MiniMax model catalogue when the live endpoint is reachable', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      expect(url).toBe('https://api.minimax.io/v1/models')
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
      capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
      contextWindow: 1000000,
    })
  })

  it('returns [] when no base URL is configured', async () => {
    expect(await minimaxDriver.listModels(creds(null))).toEqual([])
  })

  it('reports the MiniMax M3 vision capability without enabling prompt cache', () => {
    expect(minimaxDriver.capabilities('MiniMax-M3')).toMatchObject({
      toolCalling: true,
      visionInput: true,
      toolResultImages: false,
      promptCache: false,
      streaming: true,
    })
  })
})
