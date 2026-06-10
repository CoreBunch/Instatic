import { describe, expect, test } from 'bun:test'
import {
  base64ToBytes,
  bytesToBase64,
  decodeBodyBytes,
  encodeBodyBytes,
} from '../../../server/plugins/protocol/bodyEncoding'
import { performGatedFetch } from '../../../server/plugins/host/network'
import {
  materializeRouteResponse,
  serializeRouteRequest,
} from '../../../server/plugins/host/routeIo'
import type { HostPluginRecord } from '../../../server/plugins/host/types'

/**
 * Binary safety for everything crossing the plugin sandbox boundary
 * (host side). Before this wire format, fetch responses were read with
 * `response.text()` (lossy UTF-8 decode) and route bodies with
 * `request.text()` — any binary payload (PNG, gzip, protobuf, uploaded
 * PDF) was silently corrupted. These tests pin the byte-exact round trip.
 */

/** PNG signature + a NUL and some >0x7f bytes — NOT valid UTF-8. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f])

const MULTIBYTE_TEXT = 'řeřicha 🌱 — ユニコード'

describe('bodyEncoding — wire codec', () => {
  test('binary bytes round-trip through base64', () => {
    const encoded = encodeBodyBytes(PNG_BYTES)
    expect(encoded.bodyEncoding).toBe('base64')
    expect(encoded.body).toBe(bytesToBase64(PNG_BYTES))
    expect(decodeBodyBytes(encoded.body, encoded.bodyEncoding)).toEqual(PNG_BYTES)
  })

  test('valid UTF-8 (incl. multibyte) passes through as readable text', () => {
    const bytes = new TextEncoder().encode(MULTIBYTE_TEXT)
    const encoded = encodeBodyBytes(bytes)
    expect(encoded.bodyEncoding).toBe('utf8')
    expect(encoded.body).toBe(MULTIBYTE_TEXT)
    expect(decodeBodyBytes(encoded.body, encoded.bodyEncoding)).toEqual(bytes)
  })

  test('base64ToBytes inverts bytesToBase64 for every padding length', () => {
    for (const len of [0, 1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(Array.from({ length: len }, (_, i) => (i * 97 + 13) % 256))
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    }
  })
})

function makeEntry(allowlist: string[]): HostPluginRecord {
  return {
    manifest: { id: 'test.plugin', networkAllowedHosts: allowlist },
    inflightFetches: new Map(),
  } as unknown as HostPluginRecord
}

const PUBLIC_IP = '93.184.216.34'
const resolvePublic = async () => [PUBLIC_IP]

describe('performGatedFetch — binary bodies', () => {
  test('binary response bodies survive byte-exactly (base64 on the wire)', async () => {
    const res = await performGatedFetch(
      makeEntry(['cdn.example.com']),
      'https://cdn.example.com/pixel.png',
      {},
      {
        fetchImpl: (async () =>
          new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
        ) as unknown as typeof fetch,
        resolveHostAddresses: resolvePublic,
      },
    )
    expect(res.bodyEncoding).toBe('base64')
    expect(decodeBodyBytes(res.body, res.bodyEncoding)).toEqual(PNG_BYTES)
  })

  test('UTF-8 response bodies stay readable text on the wire', async () => {
    const res = await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/data',
      {},
      {
        fetchImpl: (async () => new Response(MULTIBYTE_TEXT, { status: 200 })) as unknown as typeof fetch,
        resolveHostAddresses: resolvePublic,
      },
    )
    expect(res.bodyEncoding).toBe('utf8')
    expect(res.body).toBe(MULTIBYTE_TEXT)
  })

  test('base64 request bodies reach the upstream server byte-exactly', async () => {
    let upstreamBody: Uint8Array | null = null
    await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/upload',
      { method: 'POST', body: bytesToBase64(PNG_BYTES), bodyEncoding: 'base64' },
      {
        fetchImpl: (async (_url: string, init: { body?: unknown }) => {
          upstreamBody = init.body instanceof Uint8Array ? init.body : null
          return new Response('ok', { status: 200 })
        }) as unknown as typeof fetch,
        resolveHostAddresses: resolvePublic,
      },
    )
    expect(upstreamBody).toEqual(PNG_BYTES)
  })

  test('utf8 request bodies pass through as the original string', async () => {
    let upstreamBody: unknown = null
    await performGatedFetch(
      makeEntry(['api.example.com']),
      'https://api.example.com/upload',
      { method: 'POST', body: MULTIBYTE_TEXT, bodyEncoding: 'utf8' },
      {
        fetchImpl: (async (_url: string, init: { body?: unknown }) => {
          upstreamBody = init.body
          return new Response('ok', { status: 200 })
        }) as unknown as typeof fetch,
        resolveHostAddresses: resolvePublic,
      },
    )
    expect(upstreamBody).toBe(MULTIBYTE_TEXT)
  })
})

describe('serializeRouteRequest — byte-safe route bodies', () => {
  test('multipart binary file fields reach the wire uncorrupted', async () => {
    const form = new FormData()
    form.set('file', new File([PNG_BYTES], 'pixel.png', { type: 'image/png' }))
    form.set('label', 'tiny png')
    const req = new Request('http://localhost/admin/api/cms/plugins/acme.x/runtime/upload', {
      method: 'POST',
      body: form,
    })

    const { request, body } = await serializeRouteRequest(req)

    // Raw body: multipart with binary content is not valid UTF-8 → base64,
    // and decoding restores the exact original payload bytes.
    expect(request.bodyEncoding).toBe('base64')
    const file = body.file as { __file: boolean; name: string; type: string; size: number; dataBase64: string }
    expect(file.__file).toBe(true)
    expect(file.name).toBe('pixel.png')
    expect(file.type).toBe('image/png')
    expect(file.size).toBe(PNG_BYTES.byteLength)
    expect(base64ToBytes(file.dataBase64)).toEqual(PNG_BYTES)
    expect(body.label).toBe('tiny png')
  })

  test('JSON bodies stay pre-parsed and utf8 on the wire (multibyte intact)', async () => {
    const payload = { note: MULTIBYTE_TEXT }
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const { request, body } = await serializeRouteRequest(req)
    expect(request.bodyEncoding).toBe('utf8')
    expect(request.body).toBe(JSON.stringify(payload))
    expect(body).toEqual(payload)
  })

  test('form-urlencoded fields still parse, repeated keys become arrays', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40b.cz&tags=one&tags=two',
    })
    const { body } = await serializeRouteRequest(req)
    expect(body).toEqual({ email: 'a@b.cz', tags: ['one', 'two'] })
  })

  test('raw binary bodies (application/octet-stream) survive byte-exactly', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: PNG_BYTES,
    })
    const { request, body } = await serializeRouteRequest(req)
    expect(request.bodyEncoding).toBe('base64')
    expect(decodeBodyBytes(request.body, request.bodyEncoding)).toEqual(PNG_BYTES)
    expect(body).toEqual({})
  })

  test('GET requests skip the body read entirely', async () => {
    const req = new Request('http://localhost/x', { method: 'GET' })
    const { request, body } = await serializeRouteRequest(req)
    expect(request.body).toBe('')
    expect(request.bodyEncoding).toBe('utf8')
    expect(body).toEqual({})
  })
})

describe('materializeRouteResponse — binary route responses', () => {
  test('base64 bodies decode to the exact bytes', async () => {
    const res = materializeRouteResponse({
      kind: 'response',
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: bytesToBase64(PNG_BYTES),
      bodyEncoding: 'base64',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES)
  })

  test('utf8 bodies pass through as text', async () => {
    const res = materializeRouteResponse({
      kind: 'response',
      status: 418,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: MULTIBYTE_TEXT,
      bodyEncoding: 'utf8',
    })
    expect(res.status).toBe(418)
    expect(await res.text()).toBe(MULTIBYTE_TEXT)
  })
})
