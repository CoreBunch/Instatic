/**
 * GET-only Directus REST client. No method parameter — a caller cannot
 * POST or PATCH through this module.
 */
import { safeParseJson } from '@core/utils/jsonValidate'
import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import type { DirectusConfig } from '../config'
import { isDirectusCollection, type DirectusCollection } from './collections'
import { DirectusError, directusBadGateway, directusBadRequest, directusNotConfigured } from './errors'

export const DIRECTUS_CACHE_TTL_MS = 60_000
const CACHE_MAX = 256

export type DirectusFetch = (input: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<Response>

interface CacheEntry {
  expiresAt: number
  value: DirectusItemsResponse
}

/** Directus answers `/items/*` with `{ data, meta? }`. */
const ItemsEnvelopeSchema = Type.Object({
  data: Type.Unknown(),
  meta: Type.Optional(
    Type.Object({
      filter_count: Type.Optional(Type.Number()),
      total_count: Type.Optional(Type.Number()),
    }),
  ),
})

export type DirectusItemsResponse = Static<typeof ItemsEnvelopeSchema>

const DirectusErrorBodySchema = Type.Object({
  errors: Type.Optional(Type.Array(Type.Object({ message: Type.Optional(Type.String()) }))),
  error: Type.Optional(Type.String()),
})

export interface DirectusHealth {
  /**
   * True only when Directus itself answered the probe. Deliberately not
   * named `ok`: server tool handlers return raw payloads, and `{ ok: boolean }`
   * would be read as the `AiToolOutput` envelope by the MCP layer.
   */
  reachable: boolean
  status: number
  /** Why `reachable` is false, in operator terms. */
  reason?: string
}

export interface DirectusClient {
  readonly url: string
  getItems(collection: DirectusCollection, query?: Record<string, string>): Promise<DirectusItemsResponse>
  getHealth(): Promise<DirectusHealth>
}

export function createDirectusClient(options: {
  config: DirectusConfig | null
  fetch?: DirectusFetch
  now?: () => number
  cache?: Map<string, CacheEntry>
}): DirectusClient {
  const cache = options.cache ?? new Map<string, CacheEntry>()
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))

  async function get(path: string, query?: Record<string, string>): Promise<DirectusItemsResponse> {
    const config = options.config
    if (!config) throw directusNotConfigured()

    const url = new URL(path, `${config.url}/`)
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== '') url.searchParams.set(key, value)
      }
    }
    const cacheKey = url.toString()
    const cached = cache.get(cacheKey)
    const t = now()
    if (cached && cached.expiresAt > t) return cached.value

    let res: Response
    try {
      res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/json',
        },
      })
    } catch (err) {
      throw new DirectusError(502, err instanceof Error ? err.message : 'Directus unreachable')
    }

    if (res.status >= 500) throw directusBadGateway()
    if (res.status === 404) {
      return { data: [] }
    }
    if (res.status === 401 || res.status === 403) {
      // Not the caller's fault: the reader token or the gateway in front
      // of Directus is misconfigured. A 400 would blame the query.
      throw directusBadGateway(await describeUpstreamDenial(res))
    }
    if (res.status >= 400) {
      throw directusBadRequest(await readDirectusError(res))
    }

    const value = normalizeItemsBody(await res.text())
    if (cache.size >= CACHE_MAX) cache.clear()
    cache.set(cacheKey, { expiresAt: t + DIRECTUS_CACHE_TTL_MS, value })
    return value
  }

  return {
    url: options.config?.url ?? '',
    async getItems(collection, query) {
      if (!isDirectusCollection(collection)) {
        throw directusBadRequest(`Unknown collection '${collection}'`)
      }
      return get(`items/${collection}`, query)
    },
    async getHealth() {
      const config = options.config
      if (!config) throw directusNotConfigured()
      let res: Response
      try {
        res = await fetchImpl(new URL('server/health', `${config.url}/`).toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/json',
          },
        })
      } catch (err) {
        throw new DirectusError(502, err instanceof Error ? err.message : 'Directus unreachable')
      }
      if (res.ok) return { reachable: true, status: res.status }
      if (res.status === 401 || res.status === 403) {
        return { reachable: false, status: res.status, reason: await describeUpstreamDenial(res) }
      }
      return { reachable: false, status: res.status, reason: `Directus health returned ${res.status}` }
    },
  }
}

/**
 * A bare array is the shape some proxies unwrap to; any other non-envelope
 * JSON is treated as the payload itself.
 */
function normalizeItemsBody(raw: string): DirectusItemsResponse {
  const json = safeParseJson(raw, Type.Unknown())
  if (!json.ok) throw directusBadGateway('Directus returned a non-JSON body')
  const envelope = safeParseValue(ItemsEnvelopeSchema, json.value)
  return envelope.ok ? envelope.value : { data: json.value }
}

async function readDirectusError(res: Response): Promise<string> {
  const parsed = safeParseJson(await res.text(), DirectusErrorBodySchema)
  if (parsed.ok) {
    const first = parsed.value.errors?.[0]?.message
    if (first) return first
    if (parsed.value.error) return parsed.value.error
  }
  return `Directus rejected the query (${res.status})`
}

/**
 * Distinguish "Directus said no" from "something in front of Directus said
 * no". Directus denials are JSON envelopes; a text/plain body means the
 * request was stopped at the ingress (Azure Container Apps IP restrictions
 * answer exactly `RBAC: access denied`) and the reader token was never
 * evaluated. That ingress admits the VPN egress IP, so the usual remedy is
 * to reconnect the VPN, not to touch the token.
 */
async function describeUpstreamDenial(res: Response): Promise<string> {
  const raw = (await res.text()).trim()
  const parsed = safeParseJson(raw, DirectusErrorBodySchema)
  const directusMessage = parsed.ok ? parsed.value.errors?.[0]?.message : undefined
  if (directusMessage) {
    return `Directus denied the reader token (${res.status}: ${directusMessage}). Check MKP_CONTENT_SERVICE_DIRECTUS_TOKEN and its policy.`
  }
  const detail = raw && raw.length <= 120 ? `: "${raw}"` : ''
  return `A gateway in front of Directus refused the request (${res.status}${detail}). The reader token was never evaluated. This server's egress IP is not on the Directus ingress allow-list: connect the VPN that reaches the Directus environment, or have that IP allow-listed.`
}
