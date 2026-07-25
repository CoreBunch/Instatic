import { nanoid } from 'nanoid'
import type { CoreCapability } from '@core/capabilities'
import type { McpOAuthAuthorizationRequest } from '@core/ai'
import type { DbClient } from '../../../db/client'
import { createOAuthConnection } from '../connectors/store'
import type { McpConnectorRecord } from '../connectors/types'
import {
  generateOAuthAccessToken,
  generateOAuthAuthorizationCode,
  generateOAuthRefreshToken,
  hashMcpSecret,
  pkceChallengeForVerifier,
} from '../connectors/token'
import { isValidPkceVerifier, normalizeMcpScope } from './protocol'

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60

interface OAuthClientRow {
  client_id: string
  client_name: string
  redirect_uris_json: string[]
  client_id_issued_at: number
}

export interface OAuthClientRecord {
  clientId: string
  clientName: string
  redirectUris: readonly string[]
  clientIdIssuedAt: number
}

interface AuthorizationCodeRow {
  code_hash: string
  connector_id: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  resource: string
  expires_at: string
  consumed_at: string | null
  connector_expires_at: string | null
  connector_revoked_at: string | null
}

interface OAuthTokenRow {
  id: string
  connector_id: string
  client_id: string
  scope: string
  resource: string
  expires_at: string
  revoked_at: string | null
  connector_expires_at: string | null
  connector_revoked_at: string | null
}

interface OAuthAccessGrantRow {
  connector_id: string
  user_id: string
  capabilities_json: CoreCapability[]
}

export interface OAuthAccessGrant {
  connectorId: string
  userId: string
  capabilities: readonly CoreCapability[]
}

export interface OAuthTokenPair {
  accessToken: string
  refreshToken: string
  scope: string
  expiresIn: number
}

function rowToClient(row: OAuthClientRow): OAuthClientRecord {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: Array.isArray(row.redirect_uris_json) ? row.redirect_uris_json : [],
    clientIdIssuedAt: row.client_id_issued_at,
  }
}

export async function registerOAuthClient(
  db: DbClient,
  input: { clientName: string; redirectUris: readonly string[] },
): Promise<OAuthClientRecord> {
  const clientId = `imcp_client_${nanoid(32)}`
  const issuedAt = Math.floor(Date.now() / 1000)
  const redirectUrisJson = JSON.stringify(input.redirectUris)
  const { rows } = await db<OAuthClientRow>`
    insert into ai_mcp_oauth_clients (
      client_id, client_name, redirect_uris_json, client_id_issued_at
    )
    values (${clientId}, ${input.clientName}, ${redirectUrisJson}, ${issuedAt})
    returning client_id, client_name, redirect_uris_json, client_id_issued_at
  `
  if (!rows[0]) throw new Error('OAuth client registration did not persist')
  return rowToClient(rows[0])
}

export async function findOAuthClient(db: DbClient, clientId: string): Promise<OAuthClientRecord | null> {
  const { rows } = await db<OAuthClientRow>`
    select client_id, client_name, redirect_uris_json, client_id_issued_at
    from ai_mcp_oauth_clients
    where client_id = ${clientId}
    limit 1
  `
  return rows[0] ? rowToClient(rows[0]) : null
}

export async function createOAuthAuthorizationGrant(
  db: DbClient,
  input: {
    userId: string
    clientName: string
    capabilities: readonly CoreCapability[]
    request: McpOAuthAuthorizationRequest
  },
): Promise<{ connection: McpConnectorRecord; code: string }> {
  const code = generateOAuthAuthorizationCode()
  const codeHash = await hashMcpSecret(code)
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS)

  return db.transaction(async (tx) => {
    const connection = await createOAuthConnection(tx, {
      userId: input.userId,
      label: input.clientName,
      capabilities: input.capabilities,
    })
    await tx`
      insert into ai_mcp_oauth_codes (
        code_hash, connector_id, client_id, redirect_uri, code_challenge,
        scope, resource, expires_at
      )
      values (
        ${codeHash}, ${connection.id}, ${input.request.clientId},
        ${input.request.redirectUri}, ${input.request.codeChallenge},
        ${input.request.scope}, ${input.request.resource}, ${expiresAt}
      )
    `
    return { connection, code }
  })
}

export async function exchangeAuthorizationCode(
  db: DbClient,
  input: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier: string
    resource: string
  },
  now: Date = new Date(),
): Promise<OAuthTokenPair | null> {
  if (!isValidPkceVerifier(input.codeVerifier)) return null
  const codeHash = await hashMcpSecret(input.code)
  const challenge = await pkceChallengeForVerifier(input.codeVerifier)

  return db.transaction(async (tx) => {
    const { rows } = await tx<AuthorizationCodeRow>`
      select c.code_hash, c.connector_id, c.client_id, c.redirect_uri,
             c.code_challenge, c.scope, c.resource, c.expires_at, c.consumed_at,
             g.expires_at as connector_expires_at,
             g.revoked_at as connector_revoked_at
      from ai_mcp_oauth_codes c
      join ai_mcp_connectors g on g.id = c.connector_id
      where c.code_hash = ${codeHash}
      limit 1
    `
    const code = rows[0]
    if (
      !code || code.consumed_at || code.connector_revoked_at ||
      new Date(code.expires_at).getTime() <= now.getTime() ||
      !code.connector_expires_at || new Date(code.connector_expires_at).getTime() <= now.getTime() ||
      code.client_id !== input.clientId || code.redirect_uri !== input.redirectUri ||
      code.resource !== input.resource || code.code_challenge !== challenge
    ) {
      return null
    }

    const consumed = await tx`
      update ai_mcp_oauth_codes
      set consumed_at = current_timestamp
      where code_hash = ${codeHash} and consumed_at is null
    `
    if (consumed.rowCount !== 1) return null

    return issueTokenPair(tx, {
      connectorId: code.connector_id,
      clientId: code.client_id,
      scope: code.scope,
      resource: code.resource,
      connectorExpiresAt: new Date(code.connector_expires_at),
      now,
    })
  })
}

export async function rotateRefreshToken(
  db: DbClient,
  input: {
    refreshToken: string
    clientId: string
    resource: string
    scope?: string
  },
  now: Date = new Date(),
): Promise<OAuthTokenPair | null> {
  const tokenHash = await hashMcpSecret(input.refreshToken)

  return db.transaction(async (tx) => {
    const { rows } = await tx<OAuthTokenRow>`
      select t.id, t.connector_id, t.client_id, t.scope, t.resource,
             t.expires_at, t.revoked_at,
             g.expires_at as connector_expires_at,
             g.revoked_at as connector_revoked_at
      from ai_mcp_oauth_tokens t
      join ai_mcp_connectors g on g.id = t.connector_id
      where t.token_hash = ${tokenHash} and t.kind = 'refresh'
      limit 1
    `
    const token = rows[0]
    const requestedScope = normalizeMcpScope(input.scope ?? token?.scope)

    // A rotated refresh token should never be presented again. Treat reuse as
    // credential theft and revoke the entire grant, including access tokens
    // minted from the replacement token. The client must re-authorize.
    if (token?.revoked_at && !token.connector_revoked_at) {
      await tx`
        update ai_mcp_connectors
        set revoked_at = current_timestamp
        where id = ${token.connector_id} and revoked_at is null
      `
      await tx`
        update ai_mcp_oauth_tokens
        set revoked_at = current_timestamp
        where connector_id = ${token.connector_id} and revoked_at is null
      `
      console.warn(`[ai:mcp:oauth] refresh-token reuse revoked connection ${token.connector_id}`)
      return null
    }
    if (
      !token || token.revoked_at || token.connector_revoked_at || !requestedScope ||
      new Date(token.expires_at).getTime() <= now.getTime() ||
      !token.connector_expires_at || new Date(token.connector_expires_at).getTime() <= now.getTime() ||
      token.client_id !== input.clientId || token.resource !== input.resource ||
      !scopeIsSubset(requestedScope, token.scope)
    ) {
      return null
    }

    const revoked = await tx`
      update ai_mcp_oauth_tokens
      set revoked_at = current_timestamp
      where id = ${token.id} and revoked_at is null
    `
    if (revoked.rowCount !== 1) return null

    return issueTokenPair(tx, {
      connectorId: token.connector_id,
      clientId: token.client_id,
      scope: requestedScope,
      resource: token.resource,
      connectorExpiresAt: new Date(token.connector_expires_at),
      now,
    })
  })
}

export async function findOAuthAccessGrant(
  db: DbClient,
  token: string,
  resource: string,
  now: Date = new Date(),
): Promise<OAuthAccessGrant | null> {
  const tokenHash = await hashMcpSecret(token)
  const { rows } = await db<OAuthAccessGrantRow>`
    select t.connector_id, g.user_id, g.capabilities_json
    from ai_mcp_oauth_tokens t
    join ai_mcp_connectors g on g.id = t.connector_id
    where t.token_hash = ${tokenHash}
      and t.kind = 'access'
      and t.resource = ${resource}
      and t.revoked_at is null
      and t.expires_at > ${now}
      and g.revoked_at is null
      and g.expires_at > ${now}
    limit 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    connectorId: row.connector_id,
    userId: row.user_id,
    capabilities: Array.isArray(row.capabilities_json) ? row.capabilities_json : [],
  }
}

async function issueTokenPair(
  db: DbClient,
  input: {
    connectorId: string
    clientId: string
    scope: string
    resource: string
    connectorExpiresAt: Date
    now: Date
  },
): Promise<OAuthTokenPair> {
  const accessToken = generateOAuthAccessToken()
  const refreshToken = generateOAuthRefreshToken()
  const accessExpiresAt = new Date(Math.min(
    input.now.getTime() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
    input.connectorExpiresAt.getTime(),
  ))
  const expiresIn = Math.max(1, Math.floor((accessExpiresAt.getTime() - input.now.getTime()) / 1000))

  await db`
    insert into ai_mcp_oauth_tokens (
      id, connector_id, client_id, kind, token_hash, scope, resource, expires_at
    )
    values (
      ${nanoid()}, ${input.connectorId}, ${input.clientId}, 'access',
      ${await hashMcpSecret(accessToken)}, ${input.scope}, ${input.resource}, ${accessExpiresAt}
    )
  `
  await db`
    insert into ai_mcp_oauth_tokens (
      id, connector_id, client_id, kind, token_hash, scope, resource, expires_at
    )
    values (
      ${nanoid()}, ${input.connectorId}, ${input.clientId}, 'refresh',
      ${await hashMcpSecret(refreshToken)}, ${input.scope}, ${input.resource},
      ${input.connectorExpiresAt}
    )
  `

  return { accessToken, refreshToken, scope: input.scope, expiresIn }
}

function scopeIsSubset(requested: string, granted: string): boolean {
  const grantedScopes = new Set(granted.split(/\s+/).filter(Boolean))
  return requested.split(/\s+/).filter(Boolean).every((scope) => grantedScopes.has(scope))
}
