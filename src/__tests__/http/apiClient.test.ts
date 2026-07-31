import { describe, expect, it } from 'bun:test'
import { Type } from '@core/utils/typeboxHelpers'
import {
  apiBlobRequest,
  apiRequest,
  ApiError,
  assertOk,
  isAbortError,
  readEnvelope,
  responseErrorMessage,
} from '@core/http'

const BodySchema = Type.Object({ value: Type.Number() })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('apiRequest', () => {
  it('validates the success body against the schema and returns it', async () => {
    const body = await apiRequest('/x', {
      schema: BodySchema,
      fetchImpl: async () => jsonResponse({ value: 42 }),
    })
    expect(body.value).toBe(42)
  })

  it('throws an ApiError carrying the status + envelope message on failure', async () => {
    const err = await apiRequest('/x', {
      schema: BodySchema,
      fetchImpl: async () => jsonResponse({ error: 'nope' }, 422),
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
    expect((err as ApiError).message).toBe('nope')
  })

  it('falls back to the provided message when the body has no error envelope', async () => {
    const err = await apiRequest('/x', {
      fallbackMessage: 'boom',
      fetchImpl: async () => new Response('', { status: 500 }),
    }).catch((e) => e)
    expect((err as ApiError).message).toBe('boom')
  })

  it('serializes a JSON body with a content-type header', async () => {
    let seen: RequestInit | undefined
    await apiRequest('/x', {
      method: 'POST',
      body: { hello: 'world' },
      fetchImpl: async (_input, init) => {
        seen = init
        return new Response(null, { status: 204 })
      },
    })
    expect(seen?.body).toBe(JSON.stringify({ hello: 'world' }))
    expect((seen?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('passes FormData through without JSON serialization', async () => {
    const fd = new FormData()
    fd.set('file', 'x')
    let seen: BodyInit | null | undefined
    await apiRequest('/x', {
      method: 'POST',
      body: fd,
      fetchImpl: async (_input, init) => {
        seen = init?.body
        return new Response(null, { status: 204 })
      },
    })
    expect(seen).toBe(fd)
  })

  it('appends defined query params and skips undefined ones', async () => {
    let url: RequestInfo | URL | undefined
    await apiRequest('/x', {
      query: { a: '1', b: undefined, c: 2 },
      fetchImpl: async (input) => {
        url = input
        return new Response(null, { status: 204 })
      },
    })
    expect(url).toBe('/x?a=1&c=2')
  })

  it('returns void when no schema is supplied', async () => {
    const result = await apiRequest('/x', { fetchImpl: async () => new Response(null, { status: 204 }) })
    expect(result).toBeUndefined()
  })

  it('propagates abort errors so callers can detect them with isAbortError', async () => {
    const err = await apiRequest('/x', {
      fetchImpl: async () => {
        throw new DOMException('aborted', 'AbortError')
      },
    }).catch((e) => e)
    expect(isAbortError(err)).toBe(true)
  })
})

describe('apiBlobRequest', () => {
  it('returns binary bodies through the shared authenticated transport', async () => {
    let seen: RequestInit | undefined
    const blob = await apiBlobRequest('/image', {
      fetchImpl: async (_input, init) => {
        seen = init
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' },
        })
      },
    })

    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect(seen?.credentials).toBe('include')
  })

  it('throws the same ApiError envelope as JSON requests', async () => {
    const err = await apiBlobRequest('/image', {
      fetchImpl: async () => jsonResponse({ error: 'image unavailable' }, 404),
    }).catch((error) => error)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).message).toBe('image unavailable')
  })
})

describe('readEnvelope', () => {
  it('throws ApiError on a non-OK response', async () => {
    const err = await readEnvelope(jsonResponse({ error: 'bad' }, 400), BodySchema, 'fallback').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect((err as ApiError).message).toBe('bad')
  })

  it('validates and returns the body on success', async () => {
    const body = await readEnvelope(jsonResponse({ value: 7 }), BodySchema, 'fallback')
    expect(body.value).toBe(7)
  })
})

describe('assertOk', () => {
  it('returns for an OK response and throws ApiError otherwise', async () => {
    await assertOk(new Response(null, { status: 204 }), 'fallback') // does not throw
    const err = await assertOk(jsonResponse({ error: 'denied' }, 403), 'fallback').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(403)
    expect((err as ApiError).message).toBe('denied')
  })
})

describe('responseErrorMessage', () => {
  it('prefers the JSON error envelope', async () => {
    expect(await responseErrorMessage(jsonResponse({ error: 'env' }, 500), 'fb')).toBe('env')
  })

  it('falls back to raw text, then to the fallback', async () => {
    expect(await responseErrorMessage(new Response('plain text', { status: 500 }), 'fb')).toBe('plain text')
    expect(await responseErrorMessage(new Response('', { status: 500 }), 'fb')).toBe('fb')
  })
})

describe('isAbortError', () => {
  it('recognizes DOMException and Error abort shapes', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true)
    const e = new Error('x')
    e.name = 'AbortError'
    expect(isAbortError(e)).toBe(true)
    expect(isAbortError(new Error('other'))).toBe(false)
    expect(isAbortError('nope')).toBe(false)
  })
})
