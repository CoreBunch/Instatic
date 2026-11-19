import { beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { McpOAuthAuthorizationRequest } from '@core/ai'
import type { DbClient } from '../../../db/client'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import { createSqliteClient } from '../../../db/sqlite'
import { revokeConnector } from '../connectors/store'
import {
  createOAuthAuthorizationGrant,
  findOAuthAccessGrant,
  findOAuthClient,
  mcpOAuthRealm,
  registerOAuthClient,
} from './store'
import { pkceChallengeForVerifier } from '../../../oauth/secrets'
import { exchangeAuthorizationCode, rotateRefreshToken } from '../../../oauth/grants'

const RESOURCE = 'https://cms.example.com/_instatic/mcp'
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback'
const VERIFIER = 'a'.repeat(64)

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

/**
 * Minimal DbClient stub that yields one fixed row.
 *
 * Postgres returns `bigint` columns as strings to avoid precision loss. The
 * in-memory SQLite harness above cannot reproduce that — SQLite's `integer`
 * affinity always hands back a number — so the Postgres row shape is stubbed.
 */
function stubDbReturningRow(row: Record<string, unknown>): DbClient {
  const query = (async () => ({ rows: [row], rowCount: 1 })) as unknown as DbClient
  return Object.assign(query, {
    unsafe: async () => ({ rows: [row], rowCount: 1 }),
    transaction: async <T>(fn: (tx: DbClient) => Promise<T>) => fn(query),
    dialect: 'postgres',
  }) as DbClient
}

let db: DbClient
let request: McpOAuthAuthorizationRequest

beforeEach(async () => {
  db = await freshDb()
  const client = await registerOAuthClient(db, {
    clientName: 'Claude',
    redirectUris: [REDIRECT_URI],
  })
  request = {
    responseType: 'code',
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    codeChallenge: await pkceChallengeForVerifier(VERIFIER),
    codeChallengeMethod: 'S256',
    scope: 'mcp offline_access',
    resource: RESOURCE,
    state: 'opaque-state',
  }
})

describe('MCP OAuth grant store', () => {
  it('exchanges a one-time PKCE code for resource-bound access and refresh tokens', async () => {
    const { connection, code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: 'Claude',
      capabilities: ['ai.chat', 'site.read'],
      request,
    })

    const tokens = await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })
    expect(tokens?.accessToken).toMatch(/^imcp_at_/)
    expect(tokens?.refreshToken).toMatch(/^imcp_rt_/)
    expect(tokens?.expiresIn).toBeLessThanOrEqual(3600)

    const access = await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)
    expect(access).toEqual({
      connectorId: connection.id,
      userId: 'u1',
      capabilities: ['ai.chat', 'site.read'],
    })
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, 'https://other.example/mcp')).toBeNull()

    // Another client presenting the code is refused and changes nothing.
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: 'different-client',
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })).toBeNull()
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)).not.toBeNull()

    // The same client presenting it a second time is a replay: the code is
    // refused and the tokens it already produced stop working.
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })).toBeNull()
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)).toBeNull()
  })

  it('refuses an expired code presented again without ending the connection', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: 'Claude',
      capabilities: ['site.read'],
      request,
    })
    const exchange = {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    }
    const tokens = await exchangeAuthorizationCode(db, mcpOAuthRealm, exchange)
    expect(tokens).not.toBeNull()

    // Six minutes on, the five-minute code has expired: a replay is refused
    // and the tokens it produced keep working.
    const afterExpiry = new Date(Date.now() + 6 * 60 * 1000)
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, exchange, afterExpiry)).toBeNull()
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)).not.toBeNull()
    expect(warn).not.toHaveBeenCalled()

    // While the code is still unexpired, the same replay ends the connection.
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, exchange)).toBeNull()
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('rejects a code when the verifier, callback, client, or resource differs', async () => {
    const { code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: 'Claude',
      capabilities: ['site.read'],
      request,
    })

    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: 'b'.repeat(64),
      resource: RESOURCE,
    })).toBeNull()
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: 'different-client',
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })).toBeNull()
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: 'https://attacker.example/callback',
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })).toBeNull()
    expect(await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: 'https://attacker.example/mcp',
    })).toBeNull()
  })

  it('rotates refresh tokens and invalidates the previous refresh token', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: 'Claude',
      capabilities: ['site.read'],
      request,
    })
    const initial = await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })
    const rotated = await rotateRefreshToken(db, mcpOAuthRealm, {
      refreshToken: initial!.refreshToken,
      clientId: request.clientId,
      resource: RESOURCE,
      scope: 'mcp',
    })
    expect(rotated?.accessToken).not.toBe(initial?.accessToken)
    expect(rotated?.refreshToken).not.toBe(initial?.refreshToken)
    expect(rotated?.scope).toBe('mcp')

    expect(await rotateRefreshToken(db, mcpOAuthRealm, {
      refreshToken: initial!.refreshToken,
      clientId: request.clientId,
      resource: RESOURCE,
    })).toBeNull()
    expect(await findOAuthAccessGrant(db, rotated!.accessToken, RESOURCE)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('never binds a grant to a key and has no retry for a spent refresh token', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const { code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: 'Claude',
      capabilities: ['site.read'],
      request,
    })
    // The MCP token endpoint reads no DPoP header; even handed a key, the realm takes none.
    const key = 'k'.repeat(43)
    const initial = await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
      proofThumbprint: key,
    })
    const refresh = { clientId: request.clientId, resource: RESOURCE }
    // Still unbound: a refresh with no proof works.
    const rotated = await rotateRefreshToken(db, mcpOAuthRealm, { ...refresh, refreshToken: initial!.refreshToken })
    expect(rotated).not.toBeNull()
    // The spent token again, at once and with the key: reuse, and the grant is gone.
    expect(await rotateRefreshToken(db, mcpOAuthRealm, {
      ...refresh, refreshToken: initial!.refreshToken, proofThumbprint: key,
    })).toBeNull()
    expect(await findOAuthAccessGrant(db, rotated!.accessToken, RESOURCE)).toBeNull()
    expect(await rotateRefreshToken(db, mcpOAuthRealm, { ...refresh, refreshToken: rotated!.refreshToken })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('invalidates OAuth access when the connection is revoked', async () => {
    const { connection, code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: 'Claude',
      capabilities: ['site.read'],
      request,
    })
    const tokens = await exchangeAuthorizationCode(db, mcpOAuthRealm, {
      code,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeVerifier: VERIFIER,
      resource: RESOURCE,
    })
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)).not.toBeNull()

    expect(await revokeConnector(db, connection.id, 'u1')).toBe(true)
    expect(await findOAuthAccessGrant(db, tokens!.accessToken, RESOURCE)).toBeNull()
  })

  it('reads a string-valued bigint client_id_issued_at back as a number', async () => {
    const pgDb = stubDbReturningRow({
      client_id: 'imcp_client_test',
      client_name: 'Claude',
      redirect_uris_json: [REDIRECT_URI],
      client_id_issued_at: '1786813381',
    })

    const client = await findOAuthClient(pgDb, 'imcp_client_test')

    // RFC 7591 types client_id_issued_at as a number; clients that validate the
    // registration response reject a quoted timestamp.
    expect(client?.clientIdIssuedAt).toBe(1786813381)
    expect(typeof client?.clientIdIssuedAt).toBe('number')
  })
})
