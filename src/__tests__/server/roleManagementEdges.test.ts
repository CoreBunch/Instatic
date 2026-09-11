import { describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

interface RoleListItem {
  id: string
  slug: string
  isSystem: boolean
  capabilities: string[]
}

async function listRoles(
  harness: CapabilityTestHarness,
  cookie: string,
): Promise<RoleListItem[]> {
  const res = await harness.cms('/admin/api/cms/roles', { cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ roles: RoleListItem[] }>(res)
  return body.roles
}

async function roleError(res: Response): Promise<string | undefined> {
  const body = await readJson<{ error?: string }>(res)
  return body.error
}

describe('role management edge semantics', () => {
  it('returns a conflict envelope for duplicate role slugs', async () => {
    const harness = await createCapabilityTestHarness()
    const ownerCookie = await harness.setupOwner()

    const first = await harness.cms('/admin/api/cms/roles', {
      method: 'POST',
      cookie: ownerCookie,
      json: {
        name: 'Duplicate Role',
        slug: 'duplicate-role',
        capabilities: ['site.read'],
      },
    })
    expect(first.status).toBe(201)

    const duplicate = await harness.cms('/admin/api/cms/roles', {
      method: 'POST',
      cookie: ownerCookie,
      json: {
        name: 'Duplicate Role Copy',
        slug: 'duplicate-role',
        capabilities: ['media.read'],
      },
    })
    expect(duplicate.status).toBe(409)
    expect(await roleError(duplicate)).toBe('Role slug is already in use')

    const matchingRoles = (await listRoles(harness, ownerCookie))
      .filter((role) => role.slug === 'duplicate-role')
    expect(matchingRoles).toHaveLength(1)
    expect(matchingRoles[0]?.capabilities).toEqual(['site.read'])
  })

  it('returns a conflict envelope when updating a role to an existing slug', async () => {
    const harness = await createCapabilityTestHarness()
    const ownerCookie = await harness.setupOwner()
    const firstRoleId = await harness.createRole({
      name: 'Original Slug Role',
      slug: 'original-slug-role',
      capabilities: ['site.read'],
    })
    const secondRoleId = await harness.createRole({
      name: 'Second Slug Role',
      slug: 'second-slug-role',
      capabilities: ['media.read'],
    })

    const duplicateUpdate = await harness.cms(`/admin/api/cms/roles/${secondRoleId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      json: {
        slug: 'original-slug-role',
      },
    })
    expect(duplicateUpdate.status).toBe(409)
    expect(await roleError(duplicateUpdate)).toBe('Role slug is already in use')

    const roles = await listRoles(harness, ownerCookie)
    expect(roles.find((role) => role.id === firstRoleId)).toMatchObject({
      slug: 'original-slug-role',
    })
    expect(roles.find((role) => role.id === secondRoleId)).toMatchObject({
      slug: 'second-slug-role',
    })
  })

  it('allows zero-capability roles and filters unknown capability strings', async () => {
    const harness = await createCapabilityTestHarness()
    const ownerCookie = await harness.setupOwner()

    const empty = await harness.cms('/admin/api/cms/roles', {
      method: 'POST',
      cookie: ownerCookie,
      json: {
        name: 'Zero Capability Role',
        slug: 'zero-capability-role',
        capabilities: [],
      },
    })
    expect(empty.status).toBe(201)
    const emptyPayload = await readJson<{ role: RoleListItem }>(empty)
    expect(emptyPayload.role.capabilities).toEqual([])

    const normalized = await harness.cms('/admin/api/cms/roles', {
      method: 'POST',
      cookie: ownerCookie,
      json: {
        name: 'Normalized Capabilities Role',
        slug: 'normalized-capabilities-role',
        capabilities: ['media.read', 'not.a.capability', 'site.read', 'media.read'],
      },
    })
    expect(normalized.status).toBe(201)
    const normalizedPayload = await readJson<{ role: RoleListItem }>(normalized)
    expect(normalizedPayload.role.capabilities).toEqual(['site.read', 'media.read'])
  })

  it('rejects the Owner-only roles.manage grant on every non-Owner role', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()

      const create = await harness.cms('/admin/api/cms/roles', {
        method: 'POST',
        cookie: ownerCookie,
        json: {
          name: 'Forbidden Role Manager',
          slug: 'forbidden-role-manager',
          capabilities: ['users.manage', 'roles.manage'],
        },
      })
      expect(create.status).toBe(400)
      expect(await roleError(create)).toBe('roles.manage is reserved for the Owner role')

      const roleId = await harness.createRole({
        name: 'Ordinary User Manager',
        slug: 'ordinary-user-manager',
        capabilities: ['users.manage'],
      })
      const update = await harness.cms(`/admin/api/cms/roles/${roleId}`, {
        method: 'PATCH',
        cookie: ownerCookie,
        json: { capabilities: ['users.manage', 'roles.manage'] },
      })
      expect(update.status).toBe(400)
      expect(await roleError(update)).toBe('roles.manage is reserved for the Owner role')
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects deleting system roles and roles assigned to active users', async () => {
    const harness = await createCapabilityTestHarness()
    const ownerCookie = await harness.setupOwner()

    const systemDelete = await harness.cms('/admin/api/cms/roles/admin', {
      method: 'DELETE',
      cookie: ownerCookie,
    })
    expect(systemDelete.status).toBe(409)
    expect(await roleError(systemDelete)).toBe('System roles cannot be deleted')
    expect((await listRoles(harness, ownerCookie)).find((role) => role.id === 'admin')).toMatchObject({
      isSystem: true,
    })

    const assignedRoleId = await harness.createRole({
      name: 'Assigned Role',
      slug: 'assigned-role',
      capabilities: ['site.read'],
    })
    await harness.createUser({
      email: 'assigned-role-user@example.com',
      displayName: 'Assigned Role User',
      roleId: assignedRoleId,
    })

    const assignedDelete = await harness.cms(`/admin/api/cms/roles/${assignedRoleId}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    })
    expect(assignedDelete.status).toBe(409)
    expect(await roleError(assignedDelete)).toBe('Cannot delete a role assigned to users')
    expect((await listRoles(harness, ownerCookie)).some((role) => role.id === assignedRoleId)).toBe(true)
  })
})
