import { describe, expect, it } from 'bun:test'
import { DIRECTUS_CACHE_TTL_MS, createDirectusClient } from './client'
import { DirectusError } from './errors'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Directus GET client', () => {
  it('only issues GET and never forwards an unknown collection', async () => {
    const methods: string[] = []
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      fetch: async (input, init) => {
        methods.push(init.method)
        expect(input).toContain('/items/municipalities')
        return jsonResponse({ data: [], meta: { filter_count: 0 } })
      },
    })
    await client.getItems('municipalities', { limit: '1' })
    expect(methods).toEqual(['GET'])
    await expect(client.getItems('workfields' as never)).rejects.toBeInstanceOf(DirectusError)
    await expect(client.getItems('files' as never)).rejects.toBeInstanceOf(DirectusError)
  })

  it('maps Directus 4xx to 400 and 5xx to 502', async () => {
    const four = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      fetch: async () => jsonResponse({ errors: [{ message: 'Invalid filter' }] }, 400),
    })
    try {
      await four.getItems('workfield_content')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DirectusError)
      expect((err as DirectusError).status).toBe(400)
      expect((err as DirectusError).message).toBe('Invalid filter')
    }

    const five = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      fetch: async () => jsonResponse({ error: 'boom' }, 503),
    })
    try {
      await five.getItems('workfield_content')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as DirectusError).status).toBe(502)
    }
  })

  it('reports an upstream 401/403 as 502, never as a bad query', async () => {
    const gateway = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      fetch: async () => new Response('RBAC: access denied', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      }),
    })
    try {
      await gateway.getItems('countries')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(DirectusError)
      expect((err as DirectusError).status).toBe(502)
      expect((err as DirectusError).message).toContain('gateway in front of Directus')
      expect((err as DirectusError).message).toContain('RBAC: access denied')
      expect((err as DirectusError).message).toContain('never evaluated')
      expect((err as DirectusError).message).toContain('connect the VPN')
    }

    const denied = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      fetch: async () => jsonResponse({ errors: [{ message: 'Invalid user credentials.' }] }, 401),
    })
    try {
      await denied.getItems('countries')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as DirectusError).status).toBe(502)
      expect((err as DirectusError).message).toContain('Directus denied the reader token')
      expect((err as DirectusError).message).toContain('Invalid user credentials.')
      expect((err as DirectusError).message).toContain('MKP_CONTENT_SERVICE_DIRECTUS_TOKEN')
    }
  })

  it('health is reachable only when Directus itself answers', async () => {
    const config = { url: 'https://cms.example.com', token: 'reader' }
    const up = createDirectusClient({
      config,
      fetch: async () => jsonResponse({ status: 'ok' }),
    })
    expect(await up.getHealth()).toEqual({ reachable: true, status: 200 })

    const blocked = createDirectusClient({
      config,
      fetch: async () => new Response('RBAC: access denied', { status: 403 }),
    })
    const probe = await blocked.getHealth()
    expect(probe.reachable).toBe(false)
    expect(probe.status).toBe(403)
    expect(probe.reason).toContain('gateway in front of Directus')

    const denied = createDirectusClient({
      config,
      fetch: async () => jsonResponse({ errors: [{ message: 'Invalid user credentials.' }] }, 401),
    })
    const deniedProbe = await denied.getHealth()
    expect(deniedProbe.reachable).toBe(false)
    expect(deniedProbe.reason).toContain('Directus denied the reader token')

    const teapot = createDirectusClient({
      config,
      fetch: async () => new Response('', { status: 418 }),
    })
    expect((await teapot.getHealth()).reason).toBe('Directus health returned 418')
  })

  it('health never uses the `ok` key, which the MCP layer reads as the tool envelope', async () => {
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      fetch: async () => new Response('RBAC: access denied', { status: 403 }),
    })
    expect(Object.keys(await client.getHealth())).not.toContain('ok')
  })

  it('rejects a non-JSON success body as 502 and accepts a bare array', async () => {
    const config = { url: 'https://cms.example.com', token: 'reader' }
    const html = createDirectusClient({
      config,
      fetch: async () => new Response('<html>login</html>', { status: 200 }),
    })
    try {
      await html.getItems('countries')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as DirectusError).status).toBe(502)
      expect((err as DirectusError).message).toBe('Directus returned a non-JSON body')
    }

    const bare = createDirectusClient({
      config,
      fetch: async () => jsonResponse([{ id: '1' }]),
    })
    expect(await bare.getItems('countries')).toEqual({ data: [{ id: '1' }] })

    const enveloped = createDirectusClient({
      config,
      fetch: async () => jsonResponse({ data: [{ id: '1' }], meta: { filter_count: 7, total_count: 9 } }),
    })
    expect(await enveloped.getItems('countries')).toEqual({
      data: [{ id: '1' }],
      meta: { filter_count: 7, total_count: 9 },
    })
  })

  it('caches a successful GET for 60s', async () => {
    let now = 1_000
    let hits = 0
    const client = createDirectusClient({
      config: { url: 'https://cms.example.com', token: 'reader' },
      now: () => now,
      fetch: async () => {
        hits += 1
        return jsonResponse({ data: [{ id: '1' }], meta: { filter_count: 1 } })
      },
    })
    const first = await client.getItems('countries', { limit: '1' })
    const second = await client.getItems('countries', { limit: '1' })
    expect(hits).toBe(1)
    expect(first).toEqual(second)
    now += DIRECTUS_CACHE_TTL_MS + 1
    await client.getItems('countries', { limit: '1' })
    expect(hits).toBe(2)
  })

  it('throws 503 when unconfigured', async () => {
    const client = createDirectusClient({ config: null })
    try {
      await client.getItems('countries')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as DirectusError).status).toBe(503)
    }
  })
})
