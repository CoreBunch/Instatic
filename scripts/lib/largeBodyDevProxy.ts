import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

/**
 * Vite's Node-compatible proxy can stop draining large browser request bodies
 * when Vite itself is running on Bun. Once both socket buffers fill, neither
 * side makes progress. Buffering only the large requests gives Bun's fetch
 * client a known Content-Length and avoids that backpressure deadlock while
 * leaving ordinary requests and streaming AI responses on Vite's native proxy.
 */
export const LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES = 1024 * 1024
export const MAX_DEV_PROXY_BODY_BYTES = 128 * 1024 * 1024

const LARGE_BODY_PROXY_PREFIXES = ['/admin/api/cms/'] as const
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
])

interface ProxyRequestLike {
  method?: string
  url?: string
  headers: IncomingHttpHeaders
}

export class DevProxyBodyTooLargeError extends Error {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`Development proxy request body exceeds ${maxBytes} bytes`)
    this.name = 'DevProxyBodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

function declaredBodyBytes(headers: IncomingHttpHeaders): number | null {
  const raw = headers['content-length']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export function shouldBufferLargeDevProxyRequest(req: ProxyRequestLike): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
  if (!LARGE_BODY_PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false
  const bodyBytes = declaredBodyBytes(req.headers)
  return bodyBytes !== null && bodyBytes >= LARGE_DEV_PROXY_BODY_THRESHOLD_BYTES
}

async function readBoundedRequestBody(req: IncomingMessage): Promise<Buffer> {
  const declaredBytes = declaredBodyBytes(req.headers)
  if (declaredBytes !== null && declaredBytes > MAX_DEV_PROXY_BODY_BYTES) {
    throw new DevProxyBodyTooLargeError(MAX_DEV_PROXY_BODY_BYTES)
  }

  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    receivedBytes += bytes.byteLength
    if (receivedBytes > MAX_DEV_PROXY_BODY_BYTES) {
      throw new DevProxyBodyTooLargeError(MAX_DEV_PROXY_BODY_BYTES)
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, receivedBytes)
}

function forwardedRequestHeaders(headers: IncomingHttpHeaders, bodyBytes: number): Headers {
  const forwarded = new Headers()
  for (const [name, rawValue] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || rawValue === undefined) continue
    forwarded.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : rawValue)
  }
  forwarded.set('content-length', String(bodyBytes))
  return forwarded
}

async function sendBufferedResponse(upstream: Response, res: ServerResponse): Promise<void> {
  const body = Buffer.from(await upstream.arrayBuffer())
  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) return
    headers[name] = value
  })
  headers['content-length'] = String(body.byteLength)
  res.writeHead(upstream.status, headers)
  res.end(body)
}

export async function proxyLargeDevRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetOrigin: string,
): Promise<void> {
  try {
    const body = await readBoundedRequestBody(req)
    const upstream = await fetch(new URL(req.url ?? '/', targetOrigin), {
      method: req.method,
      headers: forwardedRequestHeaders(req.headers, body.byteLength),
      body: Uint8Array.from(body),
      redirect: 'manual',
    })
    await sendBufferedResponse(upstream, res)
  } catch (err) {
    if (err instanceof DevProxyBodyTooLargeError) {
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
      return
    }
    throw err
  }
}
