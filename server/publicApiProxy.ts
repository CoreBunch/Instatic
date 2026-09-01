import {
  RequestBodyTooLargeError,
  jsonResponse,
  methodNotAllowed,
  payloadTooLarge,
  readTextBodyWithLimit,
} from './http'

const MAX_PROXY_BODY_BYTES = 64 * 1024
const UPSTREAM_TIMEOUT_MS = 10_000

const ROUTES = new Map<string, string>([
  ['/api/health', 'GET'],
  ['/api/weather', 'GET'],
  ['/api/contact', 'POST'],
  ['/api/livekit/connection-details', 'POST'],
])

interface PublicApiProxyOptions {
  baseUrl: string | null | undefined
  clientIp?: string | null
  fetch?: typeof globalThis.fetch
  publicOrigins?: readonly string[]
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers()
  for (const name of ['cache-control', 'content-type', 'etag', 'last-modified', 'retry-after']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/**
 * Same-origin gateway for a small, explicitly allowlisted public API.
 *
 * The upstream base URL is operator configuration (normally a private Railway
 * hostname). Visitors never receive it: requests and responses are relayed by
 * the Instatic server, and credentials/cookies are deliberately not copied.
 */
export async function handlePublicApiProxy(
  req: Request,
  url: URL,
  options: PublicApiProxyOptions,
): Promise<Response | null> {
  if (!options.baseUrl) return null
  if (!url.pathname.startsWith('/api/')) return null

  const allowedMethod = ROUTES.get(url.pathname)
  if (!allowedMethod) {
    return jsonResponse({ error: 'Not found' }, { status: 404 })
  }
  if (req.method !== allowedMethod) {
    const response = methodNotAllowed()
    response.headers.set('allow', allowedMethod)
    return response
  }

  const configuredOrigins = options.publicOrigins?.length
    ? options.publicOrigins
    : [url.origin]
  const inboundOrigin = req.headers.get('origin')
  const acceptedOrigin = inboundOrigin && configuredOrigins.includes(inboundOrigin)
    ? inboundOrigin
    : null
  if (req.method === 'POST' && !acceptedOrigin) {
    return jsonResponse({ error: 'Request must come from this site.' }, { status: 403 })
  }

  let body: string | undefined
  if (req.method === 'POST') {
    try {
      body = await readTextBodyWithLimit(req, MAX_PROXY_BODY_BYTES)
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        return payloadTooLarge(`Request body exceeds ${MAX_PROXY_BODY_BYTES} bytes`)
      }
      throw err
    }
  }

  const upstreamUrl = new URL(`${url.pathname}${url.search}`, `${options.baseUrl}/`)
  const headers = new Headers({ accept: req.headers.get('accept') ?? 'application/json' })
  const contentType = req.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const upstreamRequest = new Request(upstreamUrl, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  // Origin and X-Forwarded-For are forbidden browser-authored headers. Set
  // them after construction so happy-dom tests model Bun's wire Request while
  // production still receives the exact server-derived values.
  upstreamRequest.headers.set('origin', acceptedOrigin ?? configuredOrigins[0] ?? url.origin)
  if (options.clientIp) upstreamRequest.headers.set('x-forwarded-for', options.clientIp)

  try {
    const upstream = await (options.fetch ?? globalThis.fetch)(
      upstreamRequest,
    )
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream),
    })
  } catch (err) {
    console.error('[public-api-proxy] upstream request failed:', err)
    const timedOut = err instanceof Error && err.name === 'TimeoutError'
    return jsonResponse(
      { error: timedOut ? 'API service timed out.' : 'API service is unavailable.' },
      { status: timedOut ? 504 : 502 },
    )
  }
}
