/**
 * Gated outbound fetch — kernel-of-correctness for the `network.outbound`
 * permission.
 *
 * Two checks happen here:
 *  1. The plugin must have `network.outbound` granted (enforced by the
 *     caller via `assertHostPluginPermission`).
 *  2. The URL's host must match an entry in `manifest.networkAllowedHosts`
 *     (or a `*.<domain>` wildcard from that list). If `networkAllowedHosts`
 *     is empty or missing, ALL outbound is denied — fail-closed.
 *
 * The resolved address is then validated against the SSRF blocklist and
 * PINNED: the socket connects to the exact IP we checked, so a DNS rebinding
 * between check and connect cannot swing the request to an internal target.
 *
 * Returns a JSON-serializable response shape the VM-side `fetch` shim
 * reconstructs into a Response-like object. Bodies cross the boundary
 * byte-safely: the upstream response is read as raw bytes and carried as
 * UTF-8 text when possible, base64 otherwise (see `protocol/bodyEncoding.ts`).
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import {
  decodeBodyBytes,
  encodeBodyBytes,
  type BodyEncoding,
} from '../protocol/bodyEncoding'
import type { HostPluginRecord } from './types'

export interface SerializedNetworkResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  /** Response body — text verbatim for `bodyEncoding: 'utf8'`, base64 bytes otherwise. */
  body: string
  bodyEncoding: BodyEncoding
}

/**
 * Optional injectable dependencies — defaulted to the real `fetch` and the
 * system DNS resolver in production, overridden in tests to drive redirect and
 * IP-resolution scenarios deterministically.
 */
export interface GatedFetchDeps {
  fetchImpl?: typeof fetch
  resolveHostAddresses?: (host: string) => Promise<string[]>
}

/** Plugin redirect chains are capped well below the browser default of 20. */
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function hostMatchesAllowlist(host: string, allowlist: ReadonlyArray<string>): boolean {
  const lower = host.toLowerCase()
  for (const entry of allowlist) {
    const e = entry.toLowerCase()
    if (e.startsWith('*.')) {
      const suffix = e.slice(2)
      const dotSuffix = `.${suffix}`
      // Wildcard `*.foo.com` matches `bar.foo.com` but NOT `foo.com` and NOT `a.bar.foo.com`.
      if (lower.endsWith(dotSuffix)) {
        const head = lower.slice(0, lower.length - dotSuffix.length)
        if (head.length > 0 && !head.includes('.')) return true
      }
      continue
    }
    if (lower === e) return true
  }
  return false
}

/**
 * True for any address that is not a globally-routable unicast address — the
 * SSRF blocklist. `ipaddr.js` parses to a canonical value first, so every
 * spelling of an address maps to the same range: a non-canonical loopback such
 * as `::0:1` resolves to `loopback`, and the IPv6 transition prefixes NAT64
 * (`rfc6052`), 6to4, and Teredo each get their own range. Allowing only
 * `unicast` therefore blocks loopback, private, link-local (including cloud
 * metadata `169.254.169.254`), CGNAT, unique-local, unspecified, and every
 * transition prefix in one rule (GHSA-99x9, GHSA-ffj5, GHSA-c76p, GHSA-r4rj).
 *
 * A non-IP string fails closed (returns true) — callers resolve hostnames to
 * addresses before calling this.
 */
export function isBlockedAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    addr = ipaddr.parse(ip)
  } catch {
    return true
  }
  // Judge an IPv4-mapped IPv6 (`::ffff:x`) by its embedded IPv4, so a mapped
  // public address stays reachable while a mapped private one is blocked.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address()
  }
  return addr.range() !== 'unicast'
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** A validated outbound target plus the IP to pin the connection to. */
interface ValidatedTarget {
  /** The parsed request URL, still carrying the original hostname. */
  url: URL
  /** The validated IP to connect to, or `null` when the host is an IP literal. */
  pinnedIp: string | null
}

/**
 * Validate a single outbound target — protocol, host allowlist, and that no
 * resolved address falls in a blocked range — and return the parsed URL plus
 * the IP the caller must pin the connection to. Re-run for the initial URL and
 * every redirect hop, so the allowlist + IP guard remain the
 * kernel-of-correctness across the whole chain.
 */
async function assertOutboundAllowed(
  manifest: HostPluginRecord['manifest'],
  urlString: string,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<ValidatedTarget> {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Invalid URL: "${urlString}"`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Plugin network.fetch only supports http: and https: URLs (got "${parsed.protocol}")`)
  }
  const allowlist = manifest.networkAllowedHosts ?? []
  if (!hostMatchesAllowlist(parsed.host, allowlist)) {
    throw new Error(
      `Plugin "${manifest.id}" requested fetch to "${parsed.host}", which is not in the manifest's networkAllowedHosts allowlist.`,
    )
  }
  const host = stripBrackets(parsed.hostname)

  // IP-literal host: no DNS, so nothing can rebind. Validate and connect as-is.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(`Plugin "${manifest.id}" requested fetch to "${host}", which is a blocked address.`)
    }
    return { url: parsed, pinnedIp: null }
  }

  const addresses = await resolveHost(host)
  if (addresses.length === 0) {
    throw new Error(`Plugin "${manifest.id}" fetch host "${host}" did not resolve to any address.`)
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(
        `Plugin "${manifest.id}" requested fetch to "${host}", which resolves to a blocked address (${address}).`,
      )
    }
  }
  // Pin to a validated address. Every resolved address passed the blocklist, so
  // whichever the connection uses is safe; the redirect loop re-resolves and
  // re-pins each hop.
  return { url: parsed, pinnedIp: addresses[0] }
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true })
  return records.map((r) => r.address)
}

/** Drop entity-body headers when a redirect downgrades the method to GET. */
function withoutBodyHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-length' || k.toLowerCase() === 'content-type') continue
    next[k] = v
  }
  return next
}

/** Replace any host header with `host`, so the pinned request keeps the original hostname. */
function withHostHeader(headers: Record<string, string> | undefined, host: string): Record<string, string> {
  const next: Record<string, string> = {}
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'host') continue
      next[k] = v
    }
  }
  next.Host = host
  return next
}

/** Bun's `fetch` accepts a `tls` option that standard `RequestInit` omits. */
type PinnedFetchInit = RequestInit & { tls?: { serverName: string } }

/**
 * Turn a validated target into the actual request: for a hostname, rewrite the
 * URL to the pinned IP and carry the hostname in the `Host` header and (for
 * https) the TLS `serverName`, so virtual hosting and certificate validation
 * still target the host while the socket connects to the IP we checked. For an
 * IP-literal target there is nothing to pin.
 */
function buildPinnedRequest(
  parsed: URL,
  pinnedIp: string | null,
  headers: Record<string, string> | undefined,
): { url: string; headers: Record<string, string> | undefined; tls?: { serverName: string } } {
  if (pinnedIp === null) return { url: parsed.toString(), headers }

  const ipHost = isIP(pinnedIp) === 6 ? `[${pinnedIp}]` : pinnedIp
  const portPart = parsed.port ? `:${parsed.port}` : ''
  const url = `${parsed.protocol}//${ipHost}${portPart}${parsed.pathname}${parsed.search}`
  const nextHeaders = withHostHeader(headers, parsed.host)
  const tls = parsed.protocol === 'https:' ? { serverName: parsed.hostname } : undefined
  return { url, headers: nextHeaders, tls }
}

export async function performGatedFetch(
  entry: HostPluginRecord,
  urlString: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
    bodyEncoding?: BodyEncoding
    abortId?: string
  },
  deps: GatedFetchDeps = {},
): Promise<SerializedNetworkResponse> {
  const manifest = entry.manifest
  const fetchImpl = deps.fetchImpl ?? fetch
  const resolveHost = deps.resolveHostAddresses ?? defaultResolveHost

  // Per-call AbortController so the plugin's VM-side signal can short-
  // circuit the actual upstream request, not just the in-VM wait. If the
  // plugin didn't supply an abortId, we still allocate a controller so
  // crash/unload teardown can cancel it; we just don't register it for
  // lookup since no `network.abort` can ever target it.
  const controller = new AbortController()
  const abortId = init.abortId
  if (abortId) entry.inflightFetches.set(abortId, controller)

  let currentUrl = urlString
  let method = init.method ?? 'GET'
  let headers = init.headers
  // Decode the VM-supplied body once up front: a utf8 body is passed
  // through as the string (fetch UTF-8-encodes it to the same bytes), a
  // base64 body becomes the exact raw bytes the plugin handed to fetch.
  let body: string | Uint8Array<ArrayBuffer> | undefined =
    init.body !== undefined && init.bodyEncoding === 'base64'
      ? decodeBodyBytes(init.body, 'base64')
      : init.body
  try {
    for (let hop = 0; ; hop++) {
      // Re-validate protocol + allowlist + resolved-IP on EVERY hop and pin the
      // connection to the checked IP. Bun is told not to follow redirects, so
      // an allowlisted host can never bounce us to a private/internal target,
      // and the pin closes the check-then-connect DNS-rebinding gap (SSRF).
      const { url: parsed, pinnedIp } = await assertOutboundAllowed(manifest, currentUrl, resolveHost)
      const request = buildPinnedRequest(parsed, pinnedIp, headers)

      const fetchInit: PinnedFetchInit = {
        method,
        headers: request.headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      }
      if (request.tls) fetchInit.tls = request.tls

      const response = await fetchImpl(request.url, fetchInit)

      const location = response.headers.get('location')
      if (REDIRECT_STATUSES.has(response.status) && location) {
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`Plugin "${manifest.id}" fetch exceeded ${MAX_REDIRECTS} redirects.`)
        }
        // Resolve the redirect against the ORIGINAL hostname URL, not the
        // pinned IP URL, so a relative Location keeps the right host.
        const next = new URL(location, currentUrl)
        // Per the Fetch spec: 303 always becomes GET; 301/302 downgrade a
        // non-GET/HEAD request to GET and drop the body.
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')
        ) {
          method = 'GET'
          body = undefined
          headers = withoutBodyHeaders(headers)
        }
        currentUrl = next.toString()
        continue
      }

      const respHeaders: Record<string, string> = {}
      response.headers.forEach((v, k) => { respHeaders[k] = v })
      // Read the upstream body as raw bytes — `response.text()` would
      // lossily UTF-8-decode binary payloads (images, gzip, protobuf).
      const bytes = new Uint8Array(await response.arrayBuffer())
      return {
        status: response.status,
        ok: response.ok,
        headers: respHeaders,
        ...encodeBodyBytes(bytes),
      }
    }
  } finally {
    if (abortId) entry.inflightFetches.delete(abortId)
  }
}
