import { describe, expect, it } from 'bun:test'
import {
  LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES,
  MAX_DEV_PROXY_BODY_BYTES,
  shouldBufferLargeDevProxyRequest,
} from '../../scripts/lib/largeBodyDevProxy'

function request(input: {
  method?: string
  url?: string
  contentLength?: number
}) {
  return {
    method: input.method ?? 'PUT',
    url: input.url ?? '/admin/api/cms/site-document',
    headers: input.contentLength === undefined
      ? {}
      : { 'content-length': String(input.contentLength) },
  }
}

describe('large-body development proxy routing', () => {
  it('buffers large CMS request bodies before forwarding them from Bun-hosted Vite', () => {
    expect(shouldBufferLargeDevProxyRequest(request({
      contentLength: LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES,
    }))).toBe(true)
    expect(shouldBufferLargeDevProxyRequest(request({
      contentLength: MAX_DEV_PROXY_BODY_BYTES,
    }))).toBe(true)
  })

  it('leaves small, read-only, and unrelated traffic on Vite native handling', () => {
    expect(shouldBufferLargeDevProxyRequest(request({
      contentLength: LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES - 1,
    }))).toBe(false)
    expect(shouldBufferLargeDevProxyRequest(request({
      method: 'GET',
      contentLength: LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES,
    }))).toBe(false)
    expect(shouldBufferLargeDevProxyRequest(request({
      url: '/src/main.tsx',
      contentLength: LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES,
    }))).toBe(false)
    expect(shouldBufferLargeDevProxyRequest(request({
      url: '/admin/api/ai/chat/site',
      contentLength: LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES,
    }))).toBe(false)
    expect(shouldBufferLargeDevProxyRequest(request({}))).toBe(false)
  })
})
