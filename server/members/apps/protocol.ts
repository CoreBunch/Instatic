/**
 * Sign-in for apps: the authorization server a site member approves an app
 * on. Its issuer is the members path of this deployment, so its discovery
 * document does not collide with the MCP issuer on the same origin.
 */
import { MEMBER_APP_SCOPES, isMemberAppScope, parsePluginAppScope, plainLine } from '@core/members'
import { oauthIssuerOrigin } from '../../oauth/protocol'

const ISSUER_PATH = '/_instatic/members'
export const MEMBER_OAUTH_PATH_PREFIX = `${ISSUER_PATH}/oauth/`
export const MEMBER_OAUTH_AUTHORIZE_PATH = `${MEMBER_OAUTH_PATH_PREFIX}authorize`
export const MEMBER_OAUTH_TOKEN_PATH = `${MEMBER_OAUTH_PATH_PREFIX}token`
export const MEMBER_OAUTH_REVOKE_PATH = `${MEMBER_OAUTH_PATH_PREFIX}revoke`
export const MEMBER_OAUTH_USERINFO_PATH = `${MEMBER_OAUTH_PATH_PREFIX}userinfo`
/** RFC 8414: an issuer with a path publishes its metadata under the path-suffixed well-known URL. */
export const MEMBER_OAUTH_METADATA_PATH = `/.well-known/oauth-authorization-server${ISSUER_PATH}`

export const MEMBER_OAUTH_ISSUER_UNAVAILABLE_MESSAGE =
  'App sign-in needs PUBLIC_ORIGIN to be configured for this deployment.'

/**
 * The issuer, which is also the `resource` every member app token is bound
 * to. Null when the request has no trustworthy origin (see `oauthIssuerOrigin`).
 */
export function memberAppIssuer(req: Request): string | null {
  const origin = oauthIssuerOrigin(req)
  return origin ? `${origin}${ISSUER_PATH}` : null
}

/**
 * The scopes named in a scope string, in canonical order (built-in ones
 * first, then plugin scopes by name), or null when one is not a scope at all
 * or none is asked for. This checks the form only: whether an app may ask
 * for a scope, and whether a plugin still offers it, is decided where the
 * scope is used.
 */
export function parseMemberAppScope(raw: string | undefined): string[] | null {
  const requested = new Set((raw ?? '').split(/\s+/).filter(Boolean))
  if (requested.size === 0) return null
  const plugin: string[] = []
  for (const scope of requested) {
    if (isMemberAppScope(scope)) continue
    if (!parsePluginAppScope(scope)) return null
    plugin.push(scope)
  }
  return [...MEMBER_APP_SCOPES.filter((scope) => requested.has(scope)), ...plugin.sort()]
}

export function normalizeMemberAppScope(raw: string | undefined): string | null {
  return parseMemberAppScope(raw)?.join(' ') ?? null
}

const DEVICE_NAME_MAX_LENGTH = 60

/**
 * The name an app gives the device it runs on, made safe to show and cut to
 * a bounded length. Null when it gave none.
 */
export function cleanDeviceName(raw: string | null): string | null {
  const name = plainLine(raw ?? '')
  // By code point, so a character outside the basic plane is never cut in half.
  return name ? [...name].slice(0, DEVICE_NAME_MAX_LENGTH).join('').trim() : null
}

/** What every member app access token starts with, and every refresh token. */
export const MEMBER_APP_ACCESS_TOKEN_PREFIX = 'imem_at_'
export const MEMBER_APP_REFRESH_TOKEN_PREFIX = 'imem_rt_'

/**
 * Whether a header value names a member app's token anywhere in it: under
 * any `Authorization` scheme (`Bearer`, `DPoP`, `Token`, none), however it
 * is cased or spaced, well-formed or not. Plugin code is never handed such a
 * header (`serializeRouteRequest`): the token also opens other plugins'
 * routes and the member's profile.
 */
export function namesMemberAppToken(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.includes(MEMBER_APP_ACCESS_TOKEN_PREFIX) || lower.includes(MEMBER_APP_REFRESH_TOKEN_PREFIX)
}
