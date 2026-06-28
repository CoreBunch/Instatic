import { describe, it, expect, afterEach } from 'bun:test'
import { openaiCompatibleDriver } from './openaiCompatible'
import type { AiResolvedCredential } from './types'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function creds(baseUrl: string | null): AiResolvedCredential {
  return { id: 'c1', providerId: 'openai-compatible', authMode: 'baseUrl', apiKey: 'k', baseUrl }
}

describe('openai-compatible driver', () => {
  it('reports baseUrl as its only auth mode', () => {
    expect(openaiCompatibleDriver.supportedAuthModes).toEqual(['baseUrl'])
  })

  it('listModels maps /v1/models data[].id into picker models', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/models')
      return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }, { id: 'mixtral-8x7b' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const models = await openaiCompatibleDriver.listModels(creds('https://api.groq.com/openai'))
    expect(models.map((m) => m.id)).toEqual(['llama-3.3-70b', 'mixtral-8x7b'])
    expect(models[0]).toMatchObject({ label: 'llama-3.3-70b', catalogueSource: 'live' })
  })

  it('listModels normalizes a /v1-suffixed base URL (no double /v1)', async () => {
    // A user pastes the provider-documented URL including /v1 — must not produce /v1/v1/models.
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toBe('https://api.groq.com/openai/v1/models')
      return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const models = await openaiCompatibleDriver.listModels(creds('https://api.groq.com/openai/v1'))
    expect(models.map((m) => m.id)).toEqual(['llama-3.3-70b'])
  })

  it('listModels returns [] when the endpoint is unreachable or non-OK', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    expect(await openaiCompatibleDriver.listModels(creds('https://x/v1'))).toEqual([])
  })

  it('listModels returns [] with no base URL', async () => {
    expect(await openaiCompatibleDriver.listModels(creds(null))).toEqual([])
  })

  it('capabilities default to tool-calling + streaming', () => {
    expect(openaiCompatibleDriver.capabilities('anything')).toMatchObject({ toolCalling: true, streaming: true })
  })
})
