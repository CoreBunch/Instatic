import { jsonResponse } from '../../../http'
import { isLoopbackHostname, oauthIssuerOrigin } from '../../../oauth/protocol'
import {
  MCP_ENDPOINT_PATH,
  MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
} from '../paths'

export const MCP_OAUTH_SCOPE = 'mcp'
export const MCP_OAUTH_OFFLINE_SCOPE = 'offline_access'
export const MCP_OAUTH_SUPPORTED_SCOPES = [MCP_OAUTH_SCOPE, MCP_OAUTH_OFFLINE_SCOPE] as const

export const MCP_OAUTH_ISSUER_UNAVAILABLE_MESSAGE =
  'MCP OAuth needs PUBLIC_ORIGIN to be configured for this deployment.'

/**
 * The MCP authorization server's issuer: this deployment's origin. Null when
 * the request has no trustworthy origin (see `oauthIssuerOrigin`); callers
 * then answer with `mcpIssuerUnavailableResponse()` or skip the OAuth path
 * (personal access tokens never need an issuer).
 */
export function mcpIssuer(req: Request): string | null {
  return oauthIssuerOrigin(req)
}

export function mcpResource(req: Request): string | null {
  const issuer = mcpIssuer(req)
  return issuer ? `${issuer}${MCP_ENDPOINT_PATH}` : null
}

export function mcpProtectedResourceMetadataUrl(req: Request): string | null {
  const issuer = mcpIssuer(req)
  return issuer ? `${issuer}${MCP_PROTECTED_RESOURCE_METADATA_PATH}` : null
}

export function mcpOAuthEndpoints(req: Request) {
  const issuer = mcpIssuer(req)
  if (!issuer) return null
  return {
    issuer,
    resource: `${issuer}${MCP_ENDPOINT_PATH}`,
    authorizationEndpoint: `${issuer}${MCP_OAUTH_AUTHORIZE_PATH}`,
    tokenEndpoint: `${issuer}${MCP_OAUTH_TOKEN_PATH}`,
    registrationEndpoint: `${issuer}${MCP_OAUTH_REGISTER_PATH}`,
  }
}

/** The OAuth surface's answer when the deployment has no trustworthy issuer. */
export function mcpIssuerUnavailableResponse(): Response {
  return jsonResponse({ error: MCP_OAUTH_ISSUER_UNAVAILABLE_MESSAGE }, { status: 503 })
}

export function normalizeMcpScope(raw: string | undefined): string | null {
  const requested = new Set((raw ?? MCP_OAUTH_SCOPE).split(/\s+/).filter(Boolean))
  if (!requested.has(MCP_OAUTH_SCOPE)) return null
  for (const scope of requested) {
    if (!MCP_OAUTH_SUPPORTED_SCOPES.includes(scope as typeof MCP_OAUTH_SUPPORTED_SCOPES[number])) {
      return null
    }
  }
  return MCP_OAUTH_SUPPORTED_SCOPES.filter((scope) => requested.has(scope)).join(' ')
}

export function isRemoteMcpEndpoint(endpoint: string): boolean {
  const url = new URL(endpoint)
  return url.protocol === 'https:' && !isPrivateNetworkHostname(url.hostname)
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isLoopbackHostname(normalized)) return true
  if (
    (!normalized.includes('.') && !normalized.includes(':')) || normalized.endsWith('.local') ||
    normalized.endsWith('.internal') || normalized.endsWith('.lan') ||
    normalized.endsWith('.test') || normalized.endsWith('.example') ||
    normalized.endsWith('.invalid')
  ) {
    return true
  }

  const octets = normalized.split('.').map(Number)
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first, second] = octets as [number, number, number, number]
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0)
  }

  if (normalized.includes(':')) {
    if (normalized === '::' || normalized.startsWith('::ffff:')) return true
    const firstHextet = parseInt(normalized.split(':')[0] ?? '', 16)
    return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
      (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  }
  return false
}
