import { describe, expect, it } from 'bun:test'
import {
  createCapabilityTestHarness,
  expectForbidden,
  expectStepUpRequired,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

interface ListedUser {
  id: string
  email: string
}

interface ListedRole {
  id: string
  slug: string
}

interface ListedSession {
  id: string
  isCurrent: boolean
}

async function listUsers(
  harness: CapabilityTestHarness,
  cookie: string,
): Promise<ListedUser[]> {
  const res = await harness.cms('/admin/api/cms/users', { cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ users: ListedUser[] }>(res)
  return body.users
}

async function findUserByEmail(
  harness: CapabilityTestHarness,
  cookie: string,
  email: string,
): Promise<ListedUser | undefined> {
  const users = await listUsers(harness, cookie)
  return users.find((user) => user.email === email)
}

async function requireUserByEmail(
  harness: CapabilityTestHarness,
  cookie: string,
  email: string,
): Promise<ListedUser> {
  const user = await findUserByEmail(harness, cookie, email)
  if (!user) throw new Error(`Expected user ${email} to exist`)
  return user
}

async function listRoles(
  harness: CapabilityTestHarness,
  cookie: string,
): Promise<ListedRole[]> {
  const res = await harness.cms('/admin/api/cms/roles', { cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ roles: ListedRole[] }>(res)
  return body.roles
}

async function listSessions(
  harness: CapabilityTestHarness,
  cookie: string,
): Promise<ListedSession[]> {
  const res = await harness.cms('/admin/api/cms/auth/sessions', { cookie })
  expect(res.status).toBe(200)
  const body = await readJson<{ sessions: ListedSession[] }>(res)
  return body.sessions
}

describe('secondary step-up protected actions', () => {
  it('requires step-up for user deletion and keeps capability denial authoritative after step-up', async () => {
    const harness = await createCapabilityTestHarness()
    await harness.setupOwner()

    const viewer = await harness.createRoleUser({
      name: 'Step-up Viewer',
      slug: 'step-up-viewer',
      capabilities: ['site.read'],
    })
    const manager = await harness.createRoleUser({
      name: 'Step-up User Manager',
      slug: 'step-up-user-manager',
      capabilities: ['users.manage'],
    })
    const target = await harness.createRoleUser({
      name: 'Step-up Delete Target',
      slug: 'step-up-delete-target',
      capabilities: ['site.read'],
    })
    const targetUser = await requireUserByEmail(harness, manager.cookie, target.email)

    const steppedViewerCookie = await harness.stepUp(viewer.cookie)
    await expectForbidden(await harness.cms(`/admin/api/cms/users/${targetUser.id}`, {
      method: 'DELETE',
      cookie: steppedViewerCookie,
    }))
    expect(await findUserByEmail(harness, manager.cookie, target.email)).toBeDefined()

    await expectStepUpRequired(await harness.cms(`/admin/api/cms/users/${targetUser.id}`, {
      method: 'DELETE',
      cookie: manager.cookie,
    }))
    expect(await findUserByEmail(harness, manager.cookie, target.email)).toBeDefined()

    const steppedManagerCookie = await harness.stepUp(manager.cookie)
    const deleted = await harness.cms(`/admin/api/cms/users/${targetUser.id}`, {
      method: 'DELETE',
      cookie: steppedManagerCookie,
    })
    expect(deleted.status).toBe(200)
    await expect(readJson<{ ok: boolean }>(deleted)).resolves.toEqual({ ok: true })
    expect(await findUserByEmail(harness, steppedManagerCookie, target.email)).toBeUndefined()
  })

  it('requires step-up before deleting a custom role', async () => {
    const harness = await createCapabilityTestHarness()
    const ownerCookie = await harness.setupOwner()
    const roleId = await harness.createRole({
      name: 'Role Pending Step-up Delete',
      slug: 'role-pending-step-up-delete',
      capabilities: ['site.read'],
    })
    await harness.db`
      update sessions
         set step_up_expires_at = ${new Date(Date.now() - 1000)}
    `

    await expectStepUpRequired(await harness.cms(`/admin/api/cms/roles/${roleId}`, {
      method: 'DELETE',
      cookie: ownerCookie,
    }))
    expect((await listRoles(harness, ownerCookie)).some((role) => role.id === roleId)).toBe(true)

    const steppedOwnerCookie = await harness.stepUp(ownerCookie)
    const deleted = await harness.cms(`/admin/api/cms/roles/${roleId}`, {
      method: 'DELETE',
      cookie: steppedOwnerCookie,
    })
    expect(deleted.status).toBe(200)
    await expect(readJson<{ ok: boolean }>(deleted)).resolves.toEqual({ ok: true })
    expect((await listRoles(harness, steppedOwnerCookie)).some((role) => role.id === roleId)).toBe(false)
  })

  it('always requires fresh step-up before changing step-up policy settings', async () => {
    const harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const account = await harness.createRoleUser({
      name: 'Step-up Settings User',
      slug: 'step-up-settings-user',
      capabilities: ['site.read'],
    })

    const body = { mode: 'required', windowMinutes: 30 }
    await expectStepUpRequired(await harness.cms('/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      cookie: account.cookie,
      json: body,
    }))

    const steppedCookie = await harness.stepUp(account.cookie)
    const updated = await harness.cms('/admin/api/cms/me/security/step-up', {
      method: 'PATCH',
      cookie: steppedCookie,
      json: body,
    })
    expect(updated.status).toBe(200)
    const payload = await readJson<{
      user: { stepUpAuthMode: 'required' | 'disabled'; stepUpWindowMinutes: number }
    }>(updated)
    expect(payload.user.stepUpAuthMode).toBe('required')
    expect(payload.user.stepUpWindowMinutes).toBe(30)
  })

  it('requires step-up before revoking an individual secondary session', async () => {
    const harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const account = await harness.createRoleUser({
      name: 'Step-up Session User',
      slug: 'step-up-session-user',
      capabilities: ['site.read'],
    })
    await harness.sessionForEmail(account.email)
    const otherSession = (await listSessions(harness, account.cookie)).find((session) => !session.isCurrent)
    if (!otherSession) throw new Error('Expected a secondary session to revoke')

    await expectStepUpRequired(await harness.cms(
      `/admin/api/cms/auth/sessions/${encodeURIComponent(otherSession.id)}`,
      {
        method: 'DELETE',
        cookie: account.cookie,
      },
    ))
    expect((await listSessions(harness, account.cookie)).some((session) => session.id === otherSession.id)).toBe(true)

    const steppedCookie = await harness.stepUp(account.cookie)
    const revoked = await harness.cms(
      `/admin/api/cms/auth/sessions/${encodeURIComponent(otherSession.id)}`,
      {
        method: 'DELETE',
        cookie: steppedCookie,
      },
    )
    expect(revoked.status).toBe(200)
    await expect(readJson<{ ok: boolean }>(revoked)).resolves.toEqual({ ok: true })
    expect((await listSessions(harness, steppedCookie)).some((session) => session.id === otherSession.id)).toBe(false)
  })
})
