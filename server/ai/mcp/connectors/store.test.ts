import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../../db/sqlite'
import { sqliteMigrations } from '../../../db/migrations-sqlite'
import { runMigrations } from '../../../db/runMigrations'
import type { DbClient } from '../../../db/client'
import {
  createConnector,
  listConnectorsForUser,
  findConnectorByTokenHash,
  revokeConnector,
  touchConnectorLastUsed,
  toConnectorView,
} from './store'
import { hashConnectorToken } from './token'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  // The FK to users(id) requires a user row to exist.
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values ('u1', 'u1@example.com', 'u1@example.com', 'User One', 'x', 'owner')
  `
  return db
}

let db: DbClient
beforeEach(async () => { db = await freshDb() })

describe('connector store', () => {
  it('creates, lists, and projects to a token-free view', async () => {
    const rec = await createConnector(db, {
      userId: 'u1',
      label: 'Claude Code',
      type: 'local',
      capabilities: ['ai.chat', 'content.manage'],
      tokenHash: await hashConnectorToken('imcp_x'),
    })
    expect(rec.label).toBe('Claude Code')
    expect(rec.capabilities).toEqual(['ai.chat', 'content.manage'])
    expect(rec.authMode).toBe('bearer')

    const list = await listConnectorsForUser(db, 'u1')
    expect(list).toHaveLength(1)

    const view = toConnectorView(rec)
    expect(JSON.stringify(view)).not.toContain('tokenHash')
    expect(JSON.stringify(view)).not.toContain('token_hash')
    expect(view.revoked).toBe(false)
    expect(view.capabilities).toEqual(['ai.chat', 'content.manage'])
  })

  it('finds an active connector by token hash and skips revoked', async () => {
    const hash = await hashConnectorToken('imcp_y')
    const rec = await createConnector(db, {
      userId: 'u1', label: 'L', type: 'remote', capabilities: ['ai.chat'], tokenHash: hash,
    })
    const found = await findConnectorByTokenHash(db, hash)
    expect(found?.id).toBe(rec.id)

    expect(await revokeConnector(db, rec.id, 'u1')).toBe(true)
    expect(await findConnectorByTokenHash(db, hash)).toBeNull()

    // A second revoke is a no-op (already revoked).
    expect(await revokeConnector(db, rec.id, 'u1')).toBe(false)
  })

  it('does not revoke another user\'s connector', async () => {
    const rec = await createConnector(db, {
      userId: 'u1', label: 'L', type: 'local', capabilities: ['ai.chat'], tokenHash: await hashConnectorToken('imcp_z'),
    })
    expect(await revokeConnector(db, rec.id, 'someone-else')).toBe(false)
  })

  it('touches last_used_at', async () => {
    const rec = await createConnector(db, {
      userId: 'u1', label: 'L', type: 'local', capabilities: ['ai.chat'], tokenHash: await hashConnectorToken('imcp_w'),
    })
    expect(rec.lastUsedAt).toBeNull()
    await touchConnectorLastUsed(db, rec.id)
    const [reread] = await listConnectorsForUser(db, 'u1')
    expect(reread.lastUsedAt).not.toBeNull()
  })

  // ── Expiry tests ────────────────────────────────────────────────────────

  it('a freshly created token is accepted by findConnectorByTokenHash (not yet expired)', async () => {
    const hash = await hashConnectorToken('imcp_fresh')
    await createConnector(db, {
      userId: 'u1', label: 'Fresh', type: 'local', capabilities: ['ai.chat'], tokenHash: hash,
    })
    // Default now = new Date() — the token expires 90 days from creation, so it is valid.
    const found = await findConnectorByTokenHash(db, hash)
    expect(found).not.toBeNull()
    expect(found?.label).toBe('Fresh')
  })

  it('an expired token is rejected by findConnectorByTokenHash', async () => {
    const hash = await hashConnectorToken('imcp_expired')
    await createConnector(db, {
      userId: 'u1', label: 'Expired', type: 'local', capabilities: ['ai.chat'], tokenHash: hash,
      ttlDays: 30,
    })
    // Inject a `now` 31 days in the future — past the 30-day TTL.
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)
    const found = await findConnectorByTokenHash(db, hash, future)
    expect(found).toBeNull()
  })

  it('a non-expired token is still accepted when now is before expires_at', async () => {
    const hash = await hashConnectorToken('imcp_valid')
    await createConnector(db, {
      userId: 'u1', label: 'Valid', type: 'local', capabilities: ['ai.chat'], tokenHash: hash,
      ttlDays: 30,
    })
    // Inject a `now` 29 days in the future — still within the 30-day TTL.
    const soon = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000)
    const found = await findConnectorByTokenHash(db, hash, soon)
    expect(found).not.toBeNull()
  })

  it('createConnector always sets a non-null expiresAt on the returned record', async () => {
    const rec = await createConnector(db, {
      userId: 'u1', label: 'E', type: 'local', capabilities: ['ai.chat'],
      tokenHash: await hashConnectorToken('imcp_ttl'),
    })
    expect(rec.expiresAt).not.toBeNull()
    // expiresAt should be approximately 90 days from now (within ±2 minutes).
    const expiresAt = rec.expiresAt!
    const delta = new Date(expiresAt).getTime() - Date.now()
    const ninetyDays = 90 * 24 * 60 * 60 * 1000
    expect(delta).toBeGreaterThan(ninetyDays - 2 * 60 * 1000)
    expect(delta).toBeLessThan(ninetyDays + 2 * 60 * 1000)
  })

  it('toConnectorView includes expiresAt (non-null for new tokens) and never tokenHash', async () => {
    const rec = await createConnector(db, {
      userId: 'u1', label: 'V', type: 'local', capabilities: ['ai.chat'],
      tokenHash: await hashConnectorToken('imcp_view'),
    })
    const view = toConnectorView(rec)
    // expiresAt must be a non-null string for a freshly created token.
    expect(view.expiresAt).not.toBeNull()
    expect(typeof view.expiresAt).toBe('string')
    // tokenHash must never appear.
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('tokenHash')
    expect(serialized).not.toContain('token_hash')
  })

  it('custom ttlDays is honoured', async () => {
    const rec = await createConnector(db, {
      userId: 'u1', label: 'Custom TTL', type: 'local', capabilities: ['ai.chat'],
      tokenHash: await hashConnectorToken('imcp_custom'),
      ttlDays: 7,
    })
    const delta = new Date(rec.expiresAt!).getTime() - Date.now()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(delta).toBeGreaterThan(sevenDays - 2 * 60 * 1000)
    expect(delta).toBeLessThan(sevenDays + 2 * 60 * 1000)
  })

  it('createConnector with ttlDays: null creates a non-expiring token', async () => {
    const hash = await hashConnectorToken('imcp_no_expiry')
    const rec = await createConnector(db, {
      userId: 'u1', label: 'No Expiry', type: 'local', capabilities: ['ai.chat'],
      tokenHash: hash,
      ttlDays: null,
    })
    // expiresAt must be null for an explicitly non-expiring token.
    expect(rec.expiresAt).toBeNull()

    // findConnectorByTokenHash must accept the token even with `now` far in the future.
    const farFuture = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000) // 10 years
    const found = await findConnectorByTokenHash(db, hash, farFuture)
    expect(found).not.toBeNull()
    expect(found?.expiresAt).toBeNull()
  })

  it('a connector row with NULL expires_at (grandfathered) is accepted as non-expiring', async () => {
    const hash = await hashConnectorToken('imcp_null_expiry')
    const rec = await createConnector(db, {
      userId: 'u1', label: 'Legacy', type: 'local', capabilities: ['ai.chat'], tokenHash: hash,
    })
    // Simulate a pre-migration 019 row by clearing expires_at.
    await db`update ai_mcp_connectors set expires_at = null where id = ${rec.id}`
    // NULL expires_at → non-expiring; the connector must still be accepted.
    const found = await findConnectorByTokenHash(db, hash)
    expect(found).not.toBeNull()
    expect(found?.label).toBe('Legacy')
    expect(found?.expiresAt).toBeNull()
  })
})
