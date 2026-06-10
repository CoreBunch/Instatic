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
 * Returns a JSON-serializable response shape the VM-side `fetch` shim
 * reconstructs into a Response-like object. Bodies cross the boundary
 * byte-safely: the upstream response is read as raw bytes and carried as
 * UTF-8 text when possible, base64 otherwise (see `protocol/bodyEncoding.ts`).
 */

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
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

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true // malformed — fail closed
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8 "this network" / unspecified
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

function isBlockedIpv6(raw: string): boolean {
  const addr = (raw.split('%')[0] ?? '').toLowerCase() // drop zone id
  // IPv4-mapped, dotted form: ::ffff:127.0.0.1
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr)
  if (dotted?.[1]) return isBlockedIpv4(dotted[1])
  // IPv4-mapped, hex form: ::ffff:7f00:0001
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr)
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  if (addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true // loopback
  if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true // unspecified
  if (/^f[cd]/.test(addr)) return true // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true // fe80::/10 link-local
  return false
}

/**
 * True for any address in a loopback / private / link-local / CGNAT /
 * unique-local / unspecified range — the SSRF blocklist. Non-IP strings
 * return false (the caller resolves hostnames to addresses first).
 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isBlockedIpv4(ip)
  if (family === 6) return isBlockedIpv6(ip)
  return false
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Validate a single outbound target — protocol, host allowlist, and that no
 * resolved address falls in a blocked range — and return the parsed URL.
 * Re-run for the initial URL and every redirect hop, so the allowlist + IP
 * guard remain the kernel-of-correctness across the whole chain.
 */
async function assertOutboundAllowed(
  manifest: HostPluginRecord['manifest'],
  urlString: string,
  resolveHost: (host: string) => Promise<string[]>,
): Promise<URL> {
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
  const addresses = isIP(host) ? [host] : await resolveHost(host)
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
  return parsed
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
      // Re-validate protocol + allowlist + resolved-IP on EVERY hop. Bun is
      // told not to follow redirects, so an allowlisted host can never bounce
      // us to a private/internal target (SSRF).
      await assertOutboundAllowed(manifest, currentUrl, resolveHost)

      const response = await fetchImpl(currentUrl, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      })

      const location = response.headers.get('location')
      if (REDIRECT_STATUSES.has(response.status) && location) {
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`Plugin "${manifest.id}" fetch exceeded ${MAX_REDIRECTS} redirects.`)
        }
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
