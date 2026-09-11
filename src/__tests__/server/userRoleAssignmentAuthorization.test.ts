import { describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

interface UserListItem {
  id: string
  email: string
}

async function userIdFor(
  harness: CapabilityTestHarness,
  cookie: string,
  email: string,
): Promise<string> {
  const res = await harness.cms('/admin/api/cms/users', { cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ users: UserListItem[] }>(res)
  const user = body.users.find((candidate) => candidate.email === email)
  expect(user).toBeDefined()
  return user!.id
}

async function createSteppedUserManager(harness: CapabilityTestHarness): Promise<{
  cookie: string
  email: string
  userId: string
}> {
  const roleId = await harness.createRole({
    name: 'User Manager',
    slug: 'user-manager',
    capabilities: ['users.manage'],
  })
  const email = 'user-manager@example.com'
  await harness.createUser({ email, roleId })
  const cookie = await harness.stepUp(await harness.sessionForEmail(email))
  return { cookie, email, userId: await userIdFor(harness, cookie, email) }
}

describe('user role-assignment authorization', () => {
  it('rejects self-escalation to a role containing capabilities the actor does not hold', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const manager = await createSteppedUserManager(harness)

      const res = await harness.cms(`/admin/api/cms/users/${manager.userId}`, {
        method: 'PATCH',
        cookie: manager.cookie,
        json: { roleId: 'admin' },
      })

      expect(res.status).toBe(403)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toStartWith("You cannot assign capabilities you don't hold:")

      const me = await readJson<{ user: { role: { id: string }; capabilities: string[] } }>(
        await harness.cms('/admin/api/cms/me', { cookie: manager.cookie }),
      )
      expect(me.user.role.id).not.toBe('admin')
      expect(me.user.capabilities).toEqual(['users.manage'])
    } finally {
      await harness.cleanup()
    }
  })

  it('rejects creating a user with a role containing capabilities the actor does not hold', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const manager = await createSteppedUserManager(harness)

      const res = await harness.cms('/admin/api/cms/users', {
        method: 'POST',
        cookie: manager.cookie,
        json: {
          email: 'escalated-user@example.com',
          displayName: 'Escalated User',
          password: 'long-enough-password',
          roleId: 'admin',
        },
      })

      expect(res.status).toBe(403)
      const users = await readJson<{ users: UserListItem[] }>(
        await harness.cms('/admin/api/cms/users', { cookie: manager.cookie }),
      )
      expect(users.users.some((user) => user.email === 'escalated-user@example.com')).toBe(false)
    } finally {
      await harness.cleanup()
    }
  })

  it('allows assigning a role whose capabilities are a subset of the actor grants', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      await harness.setupOwner()
      const manager = await createSteppedUserManager(harness)
      const peerRoleId = await harness.createRole({
        name: 'Peer User Manager',
        slug: 'peer-user-manager',
        capabilities: ['users.manage'],
      })

      const res = await harness.cms('/admin/api/cms/users', {
        method: 'POST',
        cookie: manager.cookie,
        json: {
          email: 'peer-manager@example.com',
          displayName: 'Peer Manager',
          password: 'long-enough-password',
          roleId: peerRoleId,
        },
      })

      expect(res.status).toBe(201)
    } finally {
      await harness.cleanup()
    }
  })

  it('never activates a legacy non-Owner roles.manage grant', async () => {
    const harness = await createCapabilityTestHarness()
    try {
      const ownerCookie = await harness.setupOwner()
      await harness.db`
        insert into roles (id, slug, name, description, is_system, capabilities_json)
        values (
          ${'legacy-role-manager'},
          ${'legacy-role-manager'},
          ${'Legacy Role Manager'},
          ${'Persisted by a vulnerable older build'},
          ${false},
          ${['users.manage', 'roles.manage']}
        )
      `
      await harness.createUser({
        email: 'legacy-role-manager@example.com',
        roleId: 'legacy-role-manager',
      })

      const cookie = await harness.sessionForEmail('legacy-role-manager@example.com')
      const me = await readJson<{ user: { capabilities: string[] } }>(
        await harness.cms('/admin/api/cms/me', { cookie }),
      )
      expect(me.user.capabilities).toEqual(['users.manage'])

      const roles = await readJson<{ roles: Array<{ id: string; capabilities: string[] }> }>(
        await harness.cms('/admin/api/cms/roles', { cookie: ownerCookie }),
      )
      expect(roles.roles.find((role) => role.id === 'legacy-role-manager')?.capabilities)
        .toEqual(['users.manage'])
    } finally {
      await harness.cleanup()
    }
  })
})
