import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { createBearerConnection } from './connectors/store'
import {
  generatePersonalAccessToken,
  hashMcpSecret,
  pkceChallengeForVerifier,
} from './connectors/token'
import { resolveMcpAuth, unauthorizedResponse } from './auth'
import {
  createOAuthAuthorizationGrant,
  exchangeAuthorizationCode,
  registerOAuthClient,
} from './oauth/store'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

let db: DbClient
beforeEach(async () => { db = await freshDb() })

describe('mcp auth', () => {
  it('resolves a valid bearer token to a connector + capabilities', async () => {
    const token = generatePersonalAccessToken()
    await createBearerConnection(db, {
      userId: 'u1', label: 'L',
      capabilities: ['ai.chat', 'content.manage'], tokenHash: await hashMcpSecret(token),
    })
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    const res = await resolveMcpAuth(req, db)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.userId).toBe('u1')
      expect(res.capabilities).toContain('content.manage')
    }
  })

  it('rejects a missing token', async () => {
    const res = await resolveMcpAuth(new Request('http://x/_instatic/mcp'), db)
    expect(res.ok).toBe(false)
  })

  it('rejects an unknown token', async () => {
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: 'Bearer imcp_nope' } })
    expect((await resolveMcpAuth(req, db)).ok).toBe(false)
  })

  it('rejects a revoked connector token', async () => {
    const token = generatePersonalAccessToken()
    const rec = await createBearerConnection(db, {
      userId: 'u1', label: 'L', capabilities: ['ai.chat'], tokenHash: await hashMcpSecret(token),
    })
    await db`update ai_mcp_connectors set revoked_at = current_timestamp where id = ${rec.id}`
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    expect((await resolveMcpAuth(req, db)).ok).toBe(false)
  })

  it('rejects an expired connector token', async () => {
    const token = generatePersonalAccessToken()
    // Create a connector that expired 1 second ago.
    const pastExpiry = new Date(Date.now() - 1000).toISOString()
    const rec = await createBearerConnection(db, {
      userId: 'u1', label: 'L', capabilities: ['ai.chat'], tokenHash: await hashMcpSecret(token),
      ttlDays: 90,
    })
    // Backdate expires_at to a past timestamp to simulate expiry.
    await db`update ai_mcp_connectors set expires_at = ${pastExpiry} where id = ${rec.id}`
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    expect((await resolveMcpAuth(req, db)).ok).toBe(false)
  })

  it('accepts a grandfathered connector with NULL expires_at (non-expiring)', async () => {
    const token = generatePersonalAccessToken()
    const rec = await createBearerConnection(db, {
      userId: 'u1', label: 'Legacy', capabilities: ['ai.chat'], tokenHash: await hashMcpSecret(token),
    })
    // Simulate a pre-migration 019 row with no expiry set.
    await db`update ai_mcp_connectors set expires_at = null where id = ${rec.id}`
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    const res = await resolveMcpAuth(req, db)
    expect(res.ok).toBe(true)
  })

  it('resolves a resource-bound OAuth access token through the same capability gate', async () => {
    const verifier = 'p'.repeat(64)
    const client = await registerOAuthClient(db, {
      clientName: 'Claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    })
    const { code } = await createOAuthAuthorizationGrant(db, {
      userId: 'u1',
      clientName: client.clientName,
      capabilities: ['ai.chat', 'site.read'],
      request: {
        responseType: 'code',
        clientId: client.clientId,
        redirectUri: client.redirectUris[0]!,
        codeChallenge: await pkceChallengeForVerifier(verifier),
        codeChallengeMethod: 'S256',
        scope: 'mcp offline_access',
        resource: 'http://x/_instatic/mcp',
      },
    })
    const tokens = await exchangeAuthorizationCode(db, {
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0]!,
      codeVerifier: verifier,
      resource: 'http://x/_instatic/mcp',
    })
    const req = new Request('http://x/_instatic/mcp', {
      headers: { Authorization: `Bearer ${tokens!.accessToken}` },
    })
    const result = await resolveMcpAuth(req, db)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.capabilities).toEqual(['ai.chat', 'site.read'])
  })

  it('builds a spec-correct 401 with a resource_metadata pointer', () => {
    const r = unauthorizedResponse(new Request('http://x/_instatic/mcp'))
    expect(r.status).toBe(401)
    const wwwAuth = r.headers.get('WWW-Authenticate') ?? ''
    expect(wwwAuth).toContain('Bearer')
    expect(wwwAuth).toContain('resource_metadata')
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource')
  })
})
