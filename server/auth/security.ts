/**
 * Auth-adjacent security helpers — request-side concerns that don't fit
 * inside the auth.ts crypto/session module.
 *
 * Two independent mechanisms live here, and they no longer overlap:
 *
 *   - CSRF origin (configured public origin). `expectedOrigin` / `originAllowed`
 *     derive the site's canonical origin ONLY from `configurePublicOrigins`
 *     (set from `PUBLIC_ORIGIN` / `RENDER_EXTERNAL_URL` / `RAILWAY_PUBLIC_DOMAIN`).
 *     Forwarded headers (`X-Forwarded-Host` / `X-Forwarded-Proto`) are NOT
 *     consulted for CSRF — a TLS-terminating edge is handled by configuring
 *     the public origin, not by trusting a proxy to relay the host/scheme.
 *
 *   - Client-IP attribution (`TRUSTED_PROXY_CIDRS`). `clientIp` / `stampSocketIp`
 *     / `configureTrustedProxyCidrs` exist solely to attribute the real client
 *     IP for audit logs and rate-limit keys. `clientIp` walks `X-Forwarded-For`
 *     right-to-left and returns the nearest untrusted hop only when the socket
 *     peer is a configured trusted proxy. This has no bearing on CSRF.
 *
 * Helper roster:
 *   - `isStateChangingMethod`  — POST/PUT/PATCH/DELETE
 *   - `expectedOrigin`         — the configured canonical public origin, or a
 *                                Host/req.url fallback when none is configured.
 *   - `originAllowed`          — true when the request's Origin matches a
 *                                configured public origin / expectedOrigin, or
 *                                is on the dev allowlist.
 *   - `publicOriginIsHttps`    — true when the canonical public origin is https
 *                                (used to set the cookie `Secure` flag).
 *   - `configurePublicOrigins` — boot-time list of normalized public origins.
 *   - `clientIp`               — the nearest untrusted client IP from a
 *                                trusted proxy chain, or the socket peer
 *                                address stamped by the Bun.serve boundary.
 *   - `stampSocketIp`          — called once at the Bun.serve boundary; strips
 *                                any inbound spoof of the synthetic header
 *                                and stamps the real socket peer address so
 *                                `clientIp` has a non-proxy fallback.
 *   - `configureTrustedProxyCidrs`
 *                              — boot-time allowlist for proxy socket peers
 *                                whose `X-Forwarded-For` may be trusted for
 *                                client-IP attribution.
 *
 * Used by the CMS/AI handlers for CSRF defense-in-depth and by the login
 * endpoint for rate limiting.
 */
import { isIP } from 'node:net'
import { normalizeOrigin } from '../config'

/** Extra origins allowed by the Origin check (set via env in dev/test). */
export const DEV_ORIGIN_ALLOWLIST: string[] = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  process.env.VITE_ALLOWED_ORIGIN ?? '',
].filter(Boolean)

/** Methods that mutate server state — the only ones the Origin check applies to. */
export function isStateChangingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

/**
 * Normalized public origins, set once at boot from
 * `resolvePublicOrigins(env)`. The first entry is the canonical origin used by
 * `expectedOrigin`; the full set is matched against by `originAllowed` so a
 * platform domain and a custom domain can both be accepted.
 */
let publicOrigins: string[] = []

export function configurePublicOrigins(origins: readonly string[]): void {
  publicOrigins = origins.map(normalizeOrigin).filter((origin): origin is string => origin !== null)
}

export function resetPublicOrigins(): void {
  publicOrigins = []
}

/**
 * The origin the client *should* be talking to.
 *
 * When a public origin is configured (the normal managed-platform / reverse-
 * proxy case), the canonical first entry is authoritative — a TLS-terminating
 * edge that hands the container plain HTTP no longer breaks the CSRF check, and
 * forged `X-Forwarded-*` headers can't influence the result because we never
 * read them here. With nothing configured (direct connection), fall back to the
 * inbound `Host` header with the scheme from `req.url`.
 */
export function expectedOrigin(req: Request): string {
  const configured = publicOrigins[0]
  if (configured) return configured
  const fallback = new URL(req.url)
  const proto = fallback.protocol.replace(':', '').toLowerCase()
  const host = req.headers.get('host') ?? fallback.host
  return `${proto}://${host}`
}

/** True when the canonical configured public origin uses https. */
export function publicOriginIsHttps(): boolean {
  const configured = publicOrigins[0]
  return configured?.startsWith('https://') ?? false
}

/**
 * True when the request's `Origin` header is acceptable for a state-changing
 * action. The check is a CSRF defense-in-depth on top of `SameSite=Lax`:
 *
 *   - No Origin header → trust (curl, server-to-server, same-origin form
 *     POST in some browsers); cannot be a cross-origin browser fetch since
 *     all modern browsers send Origin for CORS-significant requests.
 *   - Origin matches expectedOrigin(req) → allow.
 *   - Origin is one of the configured public origins (custom domain +
 *     platform domain both accepted) → allow.
 *   - Origin is in the dev allowlist (Vite at :5173, etc.) → allow.
 *   - Anything else → reject.
 *
 * Both sides are normalized with `normalizeOrigin` so trailing-slash / case
 * differences never cause a false reject.
 */
export function originAllowed(req: Request): boolean {
  const rawOrigin = req.headers.get('origin')
  if (!rawOrigin) return true
  const origin = normalizeOrigin(rawOrigin)
  if (!origin) return false
  if (origin === normalizeOrigin(expectedOrigin(req))) return true
  if (publicOrigins.includes(origin)) return true
  return DEV_ORIGIN_ALLOWLIST.some((dev) => normalizeOrigin(dev) === origin)
}

/**
 * Internal synthetic header used to ferry the socket peer address from the
 * `Bun.serve` fetch boundary (where `server.requestIP(req)` is available)
 * down to the handler stack (where only `Request` is in scope).
 *
 * The header is intentionally namespaced so it can't be confused with a
 * standard one, and any inbound version is stripped in `stampSocketIp`
 * before we set our own value — clients cannot spoof it.
 */
const BUN_SOCKET_IP_HEADER = 'x-bun-socket-ip'

interface ParsedIpAddress {
  family: 4 | 6
  value: bigint
}

interface TrustedProxyRange {
  raw: string
  family: 4 | 6
  base: bigint
  prefixBits: number
  totalBits: number
}

let trustedProxyRanges: TrustedProxyRange[] = []

export function configureTrustedProxyCidrs(entries: readonly string[]): void {
  trustedProxyRanges = entries.map(parseTrustedProxyRange)
}

export function resetTrustedProxyCidrs(): void {
  trustedProxyRanges = []
}

function normalizeIpLiteral(raw: string): string {
  const trimmed = raw.trim()
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed
  const withoutZone = unbracketed.split('%', 1)[0] ?? unbracketed
  const lower = withoutZone.toLowerCase()

  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (dotted?.[1]) return dotted[1]

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }

  return lower
}

function parseIpv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const byte = Number(part)
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null
    value = value * 256 + byte
  }
  return BigInt(value)
}

function parseIpv6Part(part: string): number[] | null {
  if (!part) return []
  const out: number[] = []
  const tokens = part.split(':')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) return null
    if (token.includes('.')) {
      if (i !== tokens.length - 1) return null
      const ipv4 = parseIpv4ToBigInt(token)
      if (ipv4 === null) return null
      out.push(Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn))
      continue
    }
    if (!/^[0-9a-f]{1,4}$/i.test(token)) return null
    out.push(parseInt(token, 16))
  }
  return out
}

function parseIpv6ToBigInt(ip: string): bigint | null {
  const chunks = ip.split('::')
  if (chunks.length > 2) return null

  const head = parseIpv6Part(chunks[0] ?? '')
  const tail = chunks.length === 2 ? parseIpv6Part(chunks[1] ?? '') : []
  if (!head || !tail) return null

  if (chunks.length === 1) {
    if (head.length !== 8) return null
    return hextetsToBigInt(head)
  }

  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return hextetsToBigInt([...head, ...Array(missing).fill(0), ...tail])
}

function hextetsToBigInt(hextets: readonly number[]): bigint | null {
  if (hextets.length !== 8) return null
  let value = 0n
  for (const hextet of hextets) {
    if (!Number.isInteger(hextet) || hextet < 0 || hextet > 0xffff) return null
    value = (value << 16n) + BigInt(hextet)
  }
  return value
}

function parseIpAddress(raw: string): ParsedIpAddress | null {
  const normalized = normalizeIpLiteral(raw)
  const family = isIP(normalized)
  if (family === 4) {
    const value = parseIpv4ToBigInt(normalized)
    return value === null ? null : { family, value }
  }
  if (family === 6) {
    const value = parseIpv6ToBigInt(normalized)
    return value === null ? null : { family, value }
  }
  return null
}

function maskAddress(value: bigint, prefixBits: number, totalBits: number): bigint {
  if (prefixBits === 0) return 0n
  const hostBits = BigInt(totalBits - prefixBits)
  return (value >> hostBits) << hostBits
}

function parseTrustedProxyRange(rawEntry: string): TrustedProxyRange {
  const entry = rawEntry.trim()
  if (!entry) throw new Error('Trusted proxy CIDR cannot be empty')

  const parts = entry.split('/')
  if (parts.length > 2) throw new Error(`Invalid trusted proxy CIDR "${entry}"`)
  const parsed = parseIpAddress(parts[0] ?? '')
  if (!parsed) throw new Error(`Invalid trusted proxy address "${entry}"`)

  const totalBits = parsed.family === 4 ? 32 : 128
  const prefixBits = parts[1] === undefined ? totalBits : Number(parts[1])
  if (!Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > totalBits) {
    throw new Error(`Invalid trusted proxy CIDR prefix "${entry}"`)
  }

  return {
    raw: entry,
    family: parsed.family,
    base: maskAddress(parsed.value, prefixBits, totalBits),
    prefixBits,
    totalBits,
  }
}

function trustedProxyRangeContains(range: TrustedProxyRange, rawIp: string): boolean {
  const parsed = parseIpAddress(rawIp)
  if (!parsed || parsed.family !== range.family) return false
  return maskAddress(parsed.value, range.prefixBits, range.totalBits) === range.base
}

function isTrustedProxyPeer(rawIp: string): boolean {
  return trustedProxyRanges.some((range) => trustedProxyRangeContains(range, rawIp))
}

/**
 * Called once per request at the `Bun.serve` fetch boundary, before any
 * handler logic runs. Strips any inbound copy of the synthetic header
 * (defense against spoofing) and stamps the real socket peer address that
 * Bun surfaces via `server.requestIP(req)`.
 *
 * This is how `clientIp(req)` can return a real address in dev or any
 * self-hosted deployment that isn't fronted by a proxy setting
 * `X-Forwarded-For`.
 */
export function stampSocketIp(req: Request, address: string | null): void {
  req.headers.delete(BUN_SOCKET_IP_HEADER)
  if (address) req.headers.set(BUN_SOCKET_IP_HEADER, address)
}

/**
 * Best-effort client IP.
 *
 *   1. If the socket peer is a configured trusted proxy, walk
 *      `X-Forwarded-For` right-to-left and return the nearest untrusted IP.
 *      That avoids trusting a spoofed leftmost value preserved by the proxy.
 *   2. Otherwise ignore forwarding headers and fall back to the synthetic
 *      `x-bun-socket-ip` header that `stampSocketIp` writes from
 *      `server.requestIP(req)`. That covers dev (`bun run dev`) and any
 *      self-hosted deployment without a fronting proxy.
 *   3. If neither is available, return `null` — audit/activity logs render
 *      this as "unknown" rather than persisting a fake address.
 */
export function clientIp(req: Request): string | null {
  const socketIp = req.headers.get(BUN_SOCKET_IP_HEADER)
  if (!socketIp) return null

  const forwardedFor = req.headers.get('x-forwarded-for')
  if (forwardedFor && isTrustedProxyPeer(socketIp)) {
    const chain = forwardedFor.split(',').map((entry) => entry.trim()).filter(Boolean)
    for (let i = chain.length - 1; i >= 0; i--) {
      const candidate = chain[i]
      if (!candidate || !parseIpAddress(candidate)) continue
      if (!isTrustedProxyPeer(candidate)) return normalizeIpLiteral(candidate)
    }
  }
  return socketIp
}
