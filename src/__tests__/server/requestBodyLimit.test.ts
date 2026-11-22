import { describe, expect, it } from 'bun:test'
import { Type } from '@sinclair/typebox'
import { readValidatedBody, RequestBodyTooLargeError } from '../../../server/http'

const schema = Type.Object({ value: Type.String() })
const oversized = 129 * 1024 * 1024

describe('default JSON request body limit', () => {
  it('rejects an oversized declared body before parsing JSON', async () => {
    const req = new Request('http://localhost/admin/api/cms/login', {
      method: 'POST', body: '{"value":"ok"}',
    })
    req.headers.set('content-length', String(oversized))
    await expect(readValidatedBody(req, schema)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  it('enforces the same limit on a stream without Content-Length', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(oversized)) },
      cancel() { cancelled = true },
    })
    const req = new Request('http://localhost/admin/api/cms/login', { method: 'POST', body })
    await expect(readValidatedBody(req, schema)).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(cancelled).toBe(true)
  })

  it('keeps explicit smaller limits and normal schema validation', async () => {
    const request = () => new Request('http://localhost/', { method: 'POST', body: '{"value":"ok"}' })
    expect(await readValidatedBody(request(), schema)).toEqual({ value: 'ok' })
    await expect(readValidatedBody(request(), schema, { maxBytes: 4 })).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })
})
