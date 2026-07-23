/**
 * Wire schemas for MCP access grants and OAuth authorization.
 *
 * The admin UI manages two real credential lifecycles:
 *   - bearer access tokens explicitly created for local/CLI clients;
 *   - OAuth connections created by an authorization-code + PKCE consent flow.
 *
 * Plaintext bearer, access, refresh, and authorization-code credentials are
 * never part of a list/read projection. The one-time personal access token is
 * returned only from `CreateMcpAccessTokenResultSchema`.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { CORE_CAPABILITIES } from '@core/capabilities'

const McpAuthModeSchema = Type.Union([
  Type.Literal('bearer'),
  Type.Literal('oauth'),
])
export type McpAuthMode = Static<typeof McpAuthModeSchema>

/** Closed enum over the capability vocabulary — bodies are validated, not free text. */
const CapabilitySchema = Type.Union(CORE_CAPABILITIES.map((capability) => Type.Literal(capability)))

/** Wire-safe projection — the only persisted connection shape returned to the browser. */
export const McpConnectionViewSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  authMode: McpAuthModeSchema,
  capabilities: Type.Array(CapabilitySchema),
  createdAt: Type.String(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
  revoked: Type.Boolean(),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
})
export type McpConnectionView = Static<typeof McpConnectionViewSchema>

const McpRemoteAccessSchema = Type.Union([
  Type.Literal('public-https'),
  Type.Literal('local-only'),
])
export type McpRemoteAccess = Static<typeof McpRemoteAccessSchema>

export const McpConnectionOverviewSchema = Type.Object({
  connections: Type.Array(McpConnectionViewSchema),
  endpoint: Type.String(),
  remoteAccess: McpRemoteAccessSchema,
})
export type McpConnectionOverview = Static<typeof McpConnectionOverviewSchema>

export const CreateMcpAccessTokenBodySchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 120 }),
  capabilities: Type.Array(CapabilitySchema, { minItems: 1 }),
  /**
   * Token lifetime:
   *   number  → token expires that many days after creation (1–3650)
   *   null    → no expiry (explicit opt-in)
   *   omitted → server default (90 days)
   */
  ttlDays: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 3650 }), Type.Null()])),
})
export type CreateMcpAccessTokenBody = Static<typeof CreateMcpAccessTokenBodySchema>

/** Response to a successful token creation — carries the plaintext token exactly once. */
export const CreateMcpAccessTokenResultSchema = Type.Object({
  connection: McpConnectionViewSchema,
  accessToken: Type.String(),
})
export type CreateMcpAccessTokenResult = Static<typeof CreateMcpAccessTokenResultSchema>

export const McpOAuthAuthorizationRequestSchema = Type.Object({
  responseType: Type.Literal('code'),
  clientId: Type.String({ minLength: 1, maxLength: 2048 }),
  redirectUri: Type.String({ minLength: 1, maxLength: 4096 }),
  codeChallenge: Type.String({ minLength: 43, maxLength: 43 }),
  codeChallengeMethod: Type.Literal('S256'),
  scope: Type.String({ minLength: 1, maxLength: 256 }),
  resource: Type.String({ minLength: 1, maxLength: 4096 }),
  state: Type.Optional(Type.String({ maxLength: 2048 })),
})
export type McpOAuthAuthorizationRequest = Static<typeof McpOAuthAuthorizationRequestSchema>

export const McpOAuthAuthorizationViewSchema = Type.Object({
  clientName: Type.String(),
  callbackUrl: Type.String(),
  grantExpiresInDays: Type.Integer(),
  request: McpOAuthAuthorizationRequestSchema,
})
export type McpOAuthAuthorizationView = Static<typeof McpOAuthAuthorizationViewSchema>

export const DecideMcpOAuthAuthorizationBodySchema = Type.Object({
  decision: Type.Union([Type.Literal('approve'), Type.Literal('deny')]),
  request: McpOAuthAuthorizationRequestSchema,
  capabilities: Type.Optional(Type.Array(CapabilitySchema)),
})
export type DecideMcpOAuthAuthorizationBody = Static<typeof DecideMcpOAuthAuthorizationBodySchema>

export const DecideMcpOAuthAuthorizationResultSchema = Type.Object({
  redirectUrl: Type.String(),
})
export type DecideMcpOAuthAuthorizationResult = Static<typeof DecideMcpOAuthAuthorizationResultSchema>
