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
})
