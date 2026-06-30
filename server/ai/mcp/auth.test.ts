import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { createConnector } from './connectors/store'
import { generateConnectorToken, hashConnectorToken } from './connectors/token'
import { resolveMcpAuth, unauthorizedResponse } from './auth'

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
    const token = generateConnectorToken()
    await createConnector(db, {
      userId: 'u1', label: 'L', type: 'remote',
      capabilities: ['ai.chat', 'content.manage'], tokenHash: await hashConnectorToken(token),
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
    const token = generateConnectorToken()
    const rec = await createConnector(db, {
      userId: 'u1', label: 'L', type: 'remote', capabilities: ['ai.chat'], tokenHash: await hashConnectorToken(token),
    })
    await db`update ai_mcp_connectors set revoked_at = current_timestamp where id = ${rec.id}`
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    expect((await resolveMcpAuth(req, db)).ok).toBe(false)
  })

  it('rejects an expired connector token', async () => {
    const token = generateConnectorToken()
    // Create a connector that expired 1 second ago.
    const pastExpiry = new Date(Date.now() - 1000).toISOString()
    const rec = await createConnector(db, {
      userId: 'u1', label: 'L', type: 'remote', capabilities: ['ai.chat'], tokenHash: await hashConnectorToken(token),
      ttlDays: 90,
    })
    // Backdate expires_at to a past timestamp to simulate expiry.
    await db`update ai_mcp_connectors set expires_at = ${pastExpiry} where id = ${rec.id}`
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    expect((await resolveMcpAuth(req, db)).ok).toBe(false)
  })

  it('accepts a grandfathered connector with NULL expires_at (non-expiring)', async () => {
    const token = generateConnectorToken()
    const rec = await createConnector(db, {
      userId: 'u1', label: 'Legacy', type: 'remote', capabilities: ['ai.chat'], tokenHash: await hashConnectorToken(token),
    })
    // Simulate a pre-migration 019 row with no expiry set.
    await db`update ai_mcp_connectors set expires_at = null where id = ${rec.id}`
    const req = new Request('http://x/_instatic/mcp', { headers: { Authorization: `Bearer ${token}` } })
    const res = await resolveMcpAuth(req, db)
    expect(res.ok).toBe(true)
  })

  it('builds a spec-correct 401 with a resource_metadata pointer', () => {
    const r = unauthorizedResponse(new URL('http://x/_instatic/mcp'))
    expect(r.status).toBe(401)
    const wwwAuth = r.headers.get('WWW-Authenticate') ?? ''
    expect(wwwAuth).toContain('Bearer')
    expect(wwwAuth).toContain('resource_metadata')
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource')
  })
})
