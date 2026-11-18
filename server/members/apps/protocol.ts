/**
 * Sign-in for apps: the authorization server a site member approves an app
 * on. Its issuer is the members path of this deployment, so its discovery
 * document does not collide with the MCP issuer on the same origin.
 */
import { MEMBER_APP_SCOPES, type MemberAppScope } from '@core/members'
import { oauthIssuerOrigin } from '../../oauth/protocol'

const ISSUER_PATH = '/_instatic/members'
export const MEMBER_OAUTH_PATH_PREFIX = `${ISSUER_PATH}/oauth/`
export const MEMBER_OAUTH_AUTHORIZE_PATH = `${MEMBER_OAUTH_PATH_PREFIX}authorize`
export const MEMBER_OAUTH_TOKEN_PATH = `${MEMBER_OAUTH_PATH_PREFIX}token`
export const MEMBER_OAUTH_REVOKE_PATH = `${MEMBER_OAUTH_PATH_PREFIX}revoke`
export const MEMBER_OAUTH_USERINFO_PATH = `${MEMBER_OAUTH_PATH_PREFIX}userinfo`
export const MEMBER_OAUTH_KEYS_PATH = `${MEMBER_OAUTH_PATH_PREFIX}keys`
export const MEMBER_OAUTH_STATEMENT_PATH = `${MEMBER_OAUTH_PATH_PREFIX}statement`
/** The `typ` of an offline statement, so it cannot be mistaken for any other signed token. */
export const MEMBER_STATEMENT_TYPE = 'instatic-member-statement+jwt'
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

function isMemberAppScope(value: string): value is MemberAppScope {
  return (MEMBER_APP_SCOPES as readonly string[]).includes(value)
}

/** The scopes named in a scope string, in canonical order, or null when one is unknown or none is asked for. */
export function parseMemberAppScope(raw: string | undefined): MemberAppScope[] | null {
  const requested = new Set((raw ?? '').split(/\s+/).filter(Boolean))
  if (requested.size === 0) return null
  for (const scope of requested) if (!isMemberAppScope(scope)) return null
  return MEMBER_APP_SCOPES.filter((scope) => requested.has(scope))
}

export function normalizeMemberAppScope(raw: string | undefined): string | null {
  return parseMemberAppScope(raw)?.join(' ') ?? null
}

const DEVICE_NAME_MAX_LENGTH = 60

/**
 * The name an app gives the device it runs on, made safe to show: one line,
 * no control or invisible formatting characters (which can reorder or hide
 * text beside the Allow button), a bounded length. Null when it gave none.
 */
export function cleanDeviceName(raw: string | null): string | null {
  const name = (raw ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  // By code point, so a character outside the basic plane is never cut in half.
  return name ? [...name].slice(0, DEVICE_NAME_MAX_LENGTH).join('').trim() : null
}
