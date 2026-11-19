import { nanoid } from 'nanoid'
import type { CoreCapability } from '@core/capabilities'
import type { McpOAuthAuthorizationRequest } from '@core/ai'
import type { DbClient } from '../../../db/client'
import { createOAuthConnection } from '../connectors/store'
import type { McpConnectorRecord } from '../connectors/types'
import type {
  GrantStore,
  OAuthRealm,
  StoredAuthorizationCode,
  StoredRefreshToken,
} from '../../../oauth/grants'
import { generateOpaqueToken, hashOpaqueToken } from '../../../oauth/secrets'
import { normalizeMcpScope } from './protocol'

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60

interface OAuthClientRow {
  client_id: string
  client_name: string
  redirect_uris_json: string[]
  // `bigint` in Postgres — the driver returns int8 as a string to avoid
  // precision loss, while SQLite hands back a number. Normalized in rowToClient.
  client_id_issued_at: number | string
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

function rowToClient(row: OAuthClientRow): OAuthClientRecord {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: Array.isArray(row.redirect_uris_json) ? row.redirect_uris_json : [],
    clientIdIssuedAt: Number(row.client_id_issued_at),
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
  const code = generateOpaqueToken('imcp_ac_')
  const codeHash = await hashOpaqueToken(code)
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

/**
 * The MCP realm's rows. A code or a token is returned only while the admin
 * user who approved the grant is still active.
 */
function mcpGrantStore(tx: DbClient): GrantStore {
  return {
    async findAuthorizationCode(codeHash) {
      const { rows } = await tx<AuthorizationCodeRow>`
        select c.code_hash, c.connector_id, c.client_id, c.redirect_uri,
               c.code_challenge, c.scope, c.resource, c.expires_at, c.consumed_at,
               g.expires_at as connector_expires_at,
               g.revoked_at as connector_revoked_at
        from ai_mcp_oauth_codes c
        join ai_mcp_connectors g on g.id = c.connector_id
        join users u on u.id = g.user_id
        where c.code_hash = ${codeHash}
          and u.status = 'active' and u.deleted_at is null
        limit 1
      `
      const row = rows[0]
      return row ? codeFromRow(row) : null
    },

    async consumeAuthorizationCode(codeHash, now) {
      const consumed = await tx`
        update ai_mcp_oauth_codes
        set consumed_at = ${now}
        where code_hash = ${codeHash} and consumed_at is null
      `
      return consumed.rowCount === 1
    },

    async findRefreshToken(tokenHash) {
      const { rows } = await tx<OAuthTokenRow>`
        select t.id, t.connector_id, t.client_id, t.scope, t.resource,
               t.expires_at, t.revoked_at,
               g.expires_at as connector_expires_at,
               g.revoked_at as connector_revoked_at
        from ai_mcp_oauth_tokens t
        join ai_mcp_connectors g on g.id = t.connector_id
        join users u on u.id = g.user_id
        where t.token_hash = ${tokenHash} and t.kind = 'refresh'
          and u.status = 'active' and u.deleted_at is null
        limit 1
      `
      const row = rows[0]
      return row ? refreshTokenFromRow(row) : null
    },

    async revokeToken(tokenId, now) {
      const revoked = await tx`
        update ai_mcp_oauth_tokens
        set revoked_at = ${now}
        where id = ${tokenId} and revoked_at is null
      `
      return revoked.rowCount === 1
    },

    async revokeGrant(grantId, now) {
      await tx`
        update ai_mcp_connectors
        set revoked_at = ${now}
        where id = ${grantId} and revoked_at is null
      `
      await tx`
        update ai_mcp_oauth_tokens
        set revoked_at = ${now}
        where connector_id = ${grantId} and revoked_at is null
      `
    },

    async insertToken(token) {
      await tx`
        insert into ai_mcp_oauth_tokens (
          id, connector_id, client_id, kind, token_hash, scope, resource, expires_at
        )
        values (
          ${nanoid()}, ${token.grantId}, ${token.clientId}, ${token.kind},
          ${token.tokenHash}, ${token.scope}, ${token.resource}, ${token.expiresAt}
        )
      `
    },
  }
}

function codeFromRow(row: AuthorizationCodeRow): StoredAuthorizationCode {
  return {
    grantId: row.connector_id,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    grantExpiresAt: row.connector_expires_at,
    grantRevokedAt: row.connector_revoked_at,
    // MCP connectors are not bound to a client key.
    keyThumbprint: null,
  }
}

function refreshTokenFromRow(row: OAuthTokenRow): StoredRefreshToken {
  return {
    id: row.id,
    grantId: row.connector_id,
    clientId: row.client_id,
    scope: row.scope,
    resource: row.resource,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    grantExpiresAt: row.connector_expires_at,
    grantRevokedAt: row.connector_revoked_at,
    // MCP connectors are not bound to a client key.
    keyThumbprint: null,
  }
}

/** The authorization server MCP clients sign an admin user in with. */
export const mcpOAuthRealm: OAuthRealm = {
  logName: 'ai:mcp:oauth',
  accessTokenPrefix: 'imcp_at_',
  refreshTokenPrefix: 'imcp_rt_',
  accessTokenTtlSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  normalizeScope: normalizeMcpScope,
  store: mcpGrantStore,
}

export async function findOAuthAccessGrant(
  db: DbClient,
  token: string,
  resource: string,
  now: Date = new Date(),
): Promise<OAuthAccessGrant | null> {
  const tokenHash = await hashOpaqueToken(token)
  const { rows } = await db<OAuthAccessGrantRow>`
    select t.connector_id, g.user_id, g.capabilities_json
    from ai_mcp_oauth_tokens t
    join ai_mcp_connectors g on g.id = t.connector_id
    join users u on u.id = g.user_id
    where t.token_hash = ${tokenHash}
      and u.status = 'active' and u.deleted_at is null
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
