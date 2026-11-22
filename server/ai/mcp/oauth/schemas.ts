import { Type, safeParseValue, type Static } from '@core/utils/typeboxHelpers'
import {
  McpOAuthAuthorizationRequestSchema,
  type McpOAuthAuthorizationRequest,
} from '@core/ai'
import { hasDuplicateParameters } from '../../../oauth/protocol'

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
