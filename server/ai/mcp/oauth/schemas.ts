import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import {
  McpOAuthAuthorizationRequestSchema,
  type McpOAuthAuthorizationRequest,
} from '@core/ai'

export const OAuthClientRegistrationRequestSchema = Type.Object({
  client_name: Type.String({ minLength: 1, maxLength: 120 }),
  redirect_uris: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    minItems: 1,
    maxItems: 10,
  }),
  token_endpoint_auth_method: Type.Optional(Type.Literal('none')),
  grant_types: Type.Optional(Type.Array(Type.String())),
  response_types: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: true })
export type OAuthClientRegistrationRequest = Static<typeof OAuthClientRegistrationRequestSchema>

const AuthorizationCodeTokenRequestSchema = Type.Object({
  grant_type: Type.Literal('authorization_code'),
  code: Type.String({ minLength: 1, maxLength: 2048 }),
  redirect_uri: Type.String({ minLength: 1, maxLength: 4096 }),
  client_id: Type.String({ minLength: 1, maxLength: 2048 }),
  code_verifier: Type.String({ minLength: 43, maxLength: 128 }),
  resource: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: true })
export type AuthorizationCodeTokenRequest = Static<typeof AuthorizationCodeTokenRequestSchema>

const RefreshTokenRequestSchema = Type.Object({
  grant_type: Type.Literal('refresh_token'),
  refresh_token: Type.String({ minLength: 1, maxLength: 2048 }),
  client_id: Type.String({ minLength: 1, maxLength: 2048 }),
  resource: Type.String({ minLength: 1, maxLength: 4096 }),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: true })
export type RefreshTokenRequest = Static<typeof RefreshTokenRequestSchema>

export type OAuthTokenRequest = AuthorizationCodeTokenRequest | RefreshTokenRequest

export function parseOAuthTokenRequest(params: URLSearchParams): OAuthTokenRequest | null {
  if (hasDuplicateParameters(params)) return null
  const raw = Object.fromEntries(params.entries())
  const schema = raw.grant_type === 'authorization_code'
    ? AuthorizationCodeTokenRequestSchema
    : raw.grant_type === 'refresh_token'
      ? RefreshTokenRequestSchema
      : null
  if (!schema) return null
  const parsed = safeParseValue(schema, raw)
  return parsed.ok ? parsed.value : null
}

export function parseOAuthAuthorizationRequest(
  params: URLSearchParams,
): McpOAuthAuthorizationRequest | null {
  if (hasDuplicateParameters(params)) return null
  const raw = {
    responseType: params.get('response_type'),
    clientId: params.get('client_id'),
    redirectUri: params.get('redirect_uri'),
    codeChallenge: params.get('code_challenge'),
    codeChallengeMethod: params.get('code_challenge_method'),
    scope: params.get('scope') ?? 'mcp',
    resource: params.get('resource'),
    ...(params.has('state') ? { state: params.get('state') } : {}),
  }
  const parsed = safeParseValue(McpOAuthAuthorizationRequestSchema, raw)
  return parsed.ok ? parsed.value : null
}

function hasDuplicateParameters(params: URLSearchParams): boolean {
  const names = new Set<string>()
  for (const name of params.keys()) {
    if (names.has(name)) return true
    names.add(name)
  }
  return false
}
