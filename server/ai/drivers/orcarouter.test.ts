import { describe, it, expect, afterEach } from 'bun:test'
import { orcarouterDriver } from './orcarouter'
import type { AiResolvedCredential } from './types'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function creds(apiKey: string | null): AiResolvedCredential {
  return { id: 'c1', providerId: 'orcarouter', authMode: 'apiKey', apiKey, baseUrl: null }
}

describe('orcarouter driver', () => {
  it('reports apiKey as its only auth mode', () => {
    expect(orcarouterDriver.supportedAuthModes).toEqual(['apiKey'])
  })

  it('listModels maps /v1/models data[].id into picker models', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe('https://api.orcarouter.ai/v1/models')
      return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-5.6-sol' }, { id: 'anthropic/claude-sonnet-5' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const models = await orcarouterDriver.listModels(creds('sk-orca-test'))
    expect(models.map((m) => m.id)).toEqual(['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5'])
    expect(models[0]).toMatchObject({ label: 'openai/gpt-5.6-sol', catalogueSource: 'live' })
  })

  it('listModels returns [] when the endpoint is non-OK', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await orcarouterDriver.listModels(creds('sk-orca-test'))).toEqual([])
  })

  it('listModels returns [] with no API key', async () => {
    expect(await orcarouterDriver.listModels(creds(null))).toEqual([])
  })

  it('capabilities default to tool-calling + streaming', () => {
    expect(orcarouterDriver.capabilities('anything')).toMatchObject({ toolCalling: true, streaming: true })
  })
})
