import { describe, expect, it, beforeEach } from 'bun:test'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import type { DbClient } from '../../db/client'
import { createVisitorUser } from '../repositories'
import {
  VisitorRoleMutationError,
  createVisitorRole,
  deleteVisitorRole,
  findVisitorRoleById,
  listVisitorRoles,
  updateVisitorRole,
} from '../roles'

async function freshDb(): Promise<DbClient> {
  const db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  return db
}

describe('visitor role CRUD', () => {
  let db: DbClient

  beforeEach(async () => {
    db = await freshDb()
  })

  it('seeds the two system roles (member/admin)', async () => {
    const roles = await listVisitorRoles(db)
    const names = roles.map((r) => r.name)
    expect(names).toContain('member')
    expect(names).toContain('admin')
    expect(roles.filter((r) => r.isSystem)).toHaveLength(2)
  })

  it('creates a custom role and lists it after the system roles', async () => {
    const role = await createVisitorRole(db, { name: 'editor', capabilities: ['content.read'] })
    expect(role.name).toBe('editor')
    expect(role.capabilities).toEqual(['content.read'])
    expect(role.isSystem).toBe(false)
    expect(role.id).toBeTruthy()

    const roles = await listVisitorRoles(db)
    // System roles sort first (is_system desc), then custom by name.
    expect(roles.map((r) => r.name)).toEqual(['admin', 'member', 'editor'])
    // GET /roles still returns the new custom role (acceptance #4).
    expect(roles.some((r) => r.id === role.id)).toBe(true)
  })

  it('rejects a duplicate name with a 409 mutation error', async () => {
    await createVisitorRole(db, { name: 'editor', capabilities: [] })
    await expect(
      createVisitorRole(db, { name: 'editor', capabilities: [] }),
    ).rejects.toMatchObject({ name: 'VisitorRoleMutationError', status: 409 })
  })

  it('updates a custom role name and capabilities', async () => {
    const created = await createVisitorRole(db, { name: 'editor', capabilities: ['content.read'] })
    const updated = await updateVisitorRole(db, created.id, {
      name: 'senior-editor',
      capabilities: ['content.read', 'content.write'],
    })
    expect(updated?.name).toBe('senior-editor')
    expect(updated?.capabilities).toEqual(['content.read', 'content.write'])
  })

  it('allows editing a system role (capabilities) — system roles are editable', async () => {
    const updated = await updateVisitorRole(db, 'member', { capabilities: ['content.read'] })
    expect(updated?.name).toBe('member')
    expect(updated?.isSystem).toBe(true)
    expect(updated?.capabilities).toEqual(['content.read'])
  })

  it('rejects renaming a role onto an existing name (409)', async () => {
    await createVisitorRole(db, { name: 'editor', capabilities: [] })
    const writer = await createVisitorRole(db, { name: 'writer', capabilities: [] })
    await expect(updateVisitorRole(db, writer.id, { name: 'editor' })).rejects.toMatchObject({
      name: 'VisitorRoleMutationError',
      status: 409,
    })
  })

  it('updateVisitorRole returns null for a missing role', async () => {
    expect(await updateVisitorRole(db, 'nope', { name: 'x' })).toBeNull()
  })

  it('deletes a custom role when unassigned', async () => {
    const created = await createVisitorRole(db, { name: 'editor', capabilities: [] })
    const deleted = await deleteVisitorRole(db, created.id)
    expect(deleted?.id).toBe(created.id)
    expect(await findVisitorRoleById(db, created.id)).toBeNull()
  })

  it('refuses to delete a system role (409)', async () => {
    await expect(deleteVisitorRole(db, 'member')).rejects.toMatchObject({
      name: 'VisitorRoleMutationError',
      status: 409,
    })
    await expect(deleteVisitorRole(db, 'admin')).rejects.toMatchObject({
      name: 'VisitorRoleMutationError',
      status: 409,
    })
    // The system role is still there.
    expect(await findVisitorRoleById(db, 'member')).not.toBeNull()
  })

  it('refuses to delete a custom role that still has visitors assigned (409)', async () => {
    const role = await createVisitorRole(db, { name: 'editor', capabilities: [] })
    await createVisitorUser(db, {
      id: 'v_1',
      email: 'v@example.com',
      emailNormalized: 'v@example.com',
      passwordHash: 'hash',
      displayName: 'V',
      roleId: role.id,
    })
    // An ACTIVE visitor referencing the role blocks deletion (mirrors the
    // admin `deleteCustomRole` guard — count of active assignees). The
    // `visitor_users.role_id` FK is `on delete restrict`, so a referencing
    // active visitor must be removed first.
    await expect(deleteVisitorRole(db, role.id)).rejects.toMatchObject({
      name: 'VisitorRoleMutationError',
      status: 409,
    })
    // Reassigning the visitor to a different role frees this one for deletion.
    await db`update visitor_users set role_id = 'member', updated_at = current_timestamp where id = 'v_1'`
    const deleted = await deleteVisitorRole(db, role.id)
    expect(deleted?.id).toBe(role.id)
  })

  it('deleteVisitorRole returns null for a missing role', async () => {
    expect(await deleteVisitorRole(db, 'nope')).toBeNull()
  })
})

describe('VisitorRoleMutationError', () => {
  it('carries a status field defaulting to 400', () => {
    const err = new VisitorRoleMutationError('boom')
    expect(err.status).toBe(400)
    expect(err.message).toBe('boom')
    expect(err.name).toBe('VisitorRoleMutationError')
  })
})
