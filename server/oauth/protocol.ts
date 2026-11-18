/**
 * OAuth 2.1 rules that hold for every authorization server this process
 * runs (MCP connectors for admin users, app sign-in for site members):
 * where the issuer comes from, PKCE, redirect URIs and scopes.
 */
import { configuredPublicOrigin } from '../auth/security'

/**
 * The origin every issuer, discovery URL and `resource` comparison hangs off.
 *
 * Unauthenticated clients read the issuer back from the discovery documents
 * and the 401 challenge, so it must never come from the inbound Host header:
 * the configured public origin (`PUBLIC_ORIGIN`, or the Render / Railway
 * auto-detection) is authoritative. Without one, only a request addressed to
 * the machine itself (a loopback hostname) may use its own origin so local
 * development keeps working; Bun.serve builds `req.url` from the Host header,
 * so checking the URL covers the header. Any other request has no trustworthy
 * issuer, and the caller answers "unavailable".
 */
export function oauthIssuerOrigin(req: Request): string | null {
  const configured = configuredPublicOrigin()
  if (configured) return configured
  const url = new URL(req.url)
  return isLoopbackHostname(url.hostname) ? url.origin : null
}

export function isValidPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function isValidPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}

/** A redirect URI a client may register: https, or http on this machine. */
export function parseAllowedRedirectUri(raw: string): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password || url.hash) return null
  if (url.protocol === 'https:') return url
  if (url.protocol !== 'http:') return null
  return isLoopbackHostname(url.hostname) ? url : null
}

/**
 * Whether an authorization request's redirect URI is one the client
 * registered. The match is exact, with the one exception RFC 8252 §7.3
 * requires for native apps: on a loopback IP literal the port is ignored,
 * because the app listens on whatever port the system hands it. `localhost`
 * gets no such exception; the RFC advises against it for redirects.
 */
export function redirectUriRegistered(registered: readonly string[], candidate: string): boolean {
  if (registered.includes(candidate)) return true
  const requested = parseLoopbackIpRedirect(candidate)
  if (!requested) return false
  return registered.some((uri) => {
    const known = parseLoopbackIpRedirect(uri)
    return known !== null && known.hostname === requested.hostname &&
      known.pathname === requested.pathname && known.search === requested.search
  })
}

function parseLoopbackIpRedirect(raw: string): URL | null {
  const url = parseAllowedRedirectUri(raw)
  if (!url || url.protocol !== 'http:') return null
  return isLoopbackIpLiteral(url.hostname.replace(/^\[|\]$/g, '')) ? url : null
}

function isLoopbackIpLiteral(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === '::1'
}

/** The client's redirect URI with the authorization response added to it. */
export function oauthRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

export function scopeIsSubset(requested: string, granted: string): boolean {
  const grantedScopes = new Set(granted.split(/\s+/).filter(Boolean))
  return requested.split(/\s+/).filter(Boolean).every((scope) => grantedScopes.has(scope))
}

/** A request that names a parameter twice is refused: which one counts is ambiguous. */
export function hasDuplicateParameters(params: URLSearchParams): boolean {
  const names = new Set<string>()
  for (const name of params.keys()) {
    if (names.has(name)) return true
    names.add(name)
  }
  return false
}

/**
 * A name for this machine: `localhost`, a `.localhost` name, or a loopback IP
 * literal. A DNS name that merely starts with `127.` (`127.example.com`) is
 * somebody else's host and is not one.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized.endsWith('.localhost') || isLoopbackIpLiteral(normalized)
}
