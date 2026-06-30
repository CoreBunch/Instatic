import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from '@admin/lib/routing'
import { UsersPage } from '@users/UsersPage'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { useEditorStore } from '@site/store/store'
import type { CmsCurrentUser } from '@core/persistence'
import { makeSite } from '../fixtures'

const originalFetch = globalThis.fetch
const now = '2026-05-07T10:00:00.000Z'

const roles = [
  {
    id: 'owner',
    slug: 'owner',
    name: 'Owner',
    description: 'Permanent first-site owner with full system access.',
    isSystem: true,
    capabilities: ['site.read', 'site.structure.edit','site.content.edit','site.style.edit', 'users.manage', 'roles.manage', 'audit.read'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'admin',
    slug: 'admin',
    name: 'Admin',
    description: 'Full admin access.',
    isSystem: true,
    capabilities: ['site.read', 'site.structure.edit','site.content.edit','site.style.edit', 'plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle', 'users.manage', 'roles.manage', 'audit.read'],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'member',
    slug: 'member',
    name: 'Member',
    description: 'Public-facing member account — no admin access by default.',
    isSystem: true,
    capabilities: [],
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'custom-ops',
    slug: 'custom-ops',
    name: 'Ops',
    description: 'Can manage plugins and media.',
    isSystem: false,
    capabilities: ['site.read', 'plugins.read', 'plugins.configure', 'media.read', 'media.write'],
    createdAt: now,
    updatedAt: now,
  },
]

function userFixture(overrides: Partial<CmsCurrentUser>): CmsCurrentUser {
  return {
    id: 'user',
    email: 'user@example.com',
    displayName: 'User',
    status: 'active',
    role: roles[2],
    capabilities: roles[2].capabilities,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'required',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const users = [
  userFixture({
    id: 'owner_1',
    email: 'hello@davidbabinec.com',
    displayName: 'hello@davidbabinec.com',
    role: roles[0],
    capabilities: roles[0].capabilities,
  }),
  userFixture({
    id: 'user_1',
    email: 'test@test.com',
    displayName: 'Tester One',
    role: roles[2],
    capabilities: roles[2].capabilities,
  }),
]

const auditEvents = [
  {
    id: 'audit_1',
    actorUserId: 'owner_1',
    action: 'user.create',
    targetType: 'user',
    targetId: 'user_1',
    metadata: { roleId: 'member' },
    actorLabel: 'hello@davidbabinec.com',
    targetLabel: 'Tester One',
    metadataLabels: { roleId: 'Member' },
    ipAddress: '127.0.0.1',
    userAgent: 'Test Browser',
    createdAt: now,
  },
  {
    id: 'audit_2',
    actorUserId: null,
    action: 'login.failure',
    targetType: 'user',
    targetId: null,
    metadata: { email: 'missing@example.com' },
    actorLabel: null,
    targetLabel: null,
    metadataLabels: {},
    ipAddress: 'unknown',
    userAgent: 'Test Browser',
    createdAt: now,
  },
  {
    id: 'audit_3',
    actorUserId: 'owner_1',
    action: 'role.delete',
    targetType: 'role',
    targetId: 'deleted-role',
    metadata: { name: 'Deleted Role', slug: 'deleted-role' },
    actorLabel: 'hello@davidbabinec.com',
    targetLabel: 'Deleted Role',
    metadataLabels: {},
    ipAddress: null,
    userAgent: 'Test Browser',
    createdAt: now,
  },
]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Ambient fetch fallback for endpoints AdminPageLayout calls on mount
 * (site load, plugin list) so individual tests don't have to enumerate
 * them. Returns `undefined` for non-ambient URLs — the caller's own
 * handler should still answer those.
 */
function ambientFetchFallback(url: string): Response | undefined {
  if (url.endsWith('/admin/api/cms/plugins')) {
    return json({ plugins: [], adminPages: [] })
  }
  if (url.endsWith('/admin/api/cms/site')) {
    return json({ site: null }, 404)
  }
  if (url.endsWith('/admin/api/cms/site/publish-status')) {
    return json({ ok: false }, 404)
  }
  return undefined
}

function Wrapper({
  user,
  children,
}: {
  user: CmsCurrentUser
  children: ReactNode
}) {
  return (
    <MemoryRouter>
      <AdminSessionProvider user={user}>
        <StepUpProvider>{children}</StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>
  )
}

function currentUser(capabilities: string[]): CmsCurrentUser {
  return {
    id: 'current-user',
    email: 'current@example.com',
    displayName: 'Current User',
    status: 'active',
    role: {
      id: 'custom',
      slug: 'custom',
      name: 'Custom',
      description: '',
      isSystem: false,
      capabilities,
    },
    capabilities,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'required',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: now,
    updatedAt: now,
  }
}

function setupEditorState() {
  const site = makeSite({ name: 'Users Test Site' })
  useEditorStore.setState({
    site,
    activePageId: site.pages[0].id,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    leftSidebarWidth: 320,
    focusedPanel: 'canvas',
    codeEditorPanelOpen: false,
    activeEditorFileId: null,
    activeMediaAssetPreview: null,
    dependenciesPanelOpen: false,
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => {
  localStorage.clear()
  setupEditorState()
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/admin/api/cms/users' && init?.method === 'GET') return json({ users })
    if (url === '/admin/api/cms/roles' && init?.method === 'GET') return json({ roles })
    if (url === '/admin/api/cms/audit' && init?.method === 'GET') return json({ events: auditEvents })
    const ambient = ambientFetchFallback(url)
    if (ambient) return ambient
    return json({ error: `Unhandled ${url}` }, 500)
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('UsersPage', () => {
  it('limits a user manager to user management affordances and supporting role options', async () => {
    const calls: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/admin/api/cms/users' && init?.method === 'GET') return json({ users })
      if (url === '/admin/api/cms/roles' && init?.method === 'GET') return json({ roles })
      if (url === '/admin/api/cms/audit' && init?.method === 'GET') return json({ events: auditEvents })
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper user={currentUser(['users.manage'])}>
        <UsersPage />
      </Wrapper>,
    )

    expect(await screen.findByRole('table', { name: 'Users' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Users' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Roles' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Audit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create User' })).toBeDefined()
    expect(calls).toContain('GET /admin/api/cms/users')
    expect(calls).toContain('GET /admin/api/cms/roles')
    expect(calls).not.toContain('GET /admin/api/cms/audit')
  })

  it('limits a role manager to role management affordances without fetching users or audit events', async () => {
    const calls: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/admin/api/cms/users' && init?.method === 'GET') return json({ users })
      if (url === '/admin/api/cms/roles' && init?.method === 'GET') return json({ roles })
      if (url === '/admin/api/cms/audit' && init?.method === 'GET') return json({ events: auditEvents })
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper user={currentUser(['roles.manage'])}>
        <UsersPage />
      </Wrapper>,
    )

    expect(await screen.findByRole('table', { name: 'Roles' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Users' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Roles' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Audit' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Role' })).toBeDefined()
    expect(calls).not.toContain('GET /admin/api/cms/users')
    expect(calls).toContain('GET /admin/api/cms/roles')
    expect(calls).not.toContain('GET /admin/api/cms/audit')
  })

  it('limits an audit reader to audit affordances without fetching user or role management data', async () => {
    const calls: string[] = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === '/admin/api/cms/users' && init?.method === 'GET') return json({ users })
      if (url === '/admin/api/cms/roles' && init?.method === 'GET') return json({ roles })
      if (url === '/admin/api/cms/audit' && init?.method === 'GET') return json({ events: auditEvents })
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }
    useEditorStore.setState({
      site: null,
      activePageId: null,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(
      <Wrapper user={currentUser(['audit.read'])}>
        <UsersPage />
      </Wrapper>,
    )

    expect(await screen.findByRole('table', { name: 'Audit events' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Users' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Roles' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Audit' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /create user/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /create role/i })).toBeNull()
    expect(screen.getByText('Tester One was created')).toBeDefined()
    expect(screen.getAllByText('by hello@davidbabinec.com').length).toBeGreaterThan(0)
    expect(screen.getByText('Role: Member')).toBeDefined()
    expect(screen.getByText('Deleted Role was deleted')).toBeDefined()
    expect(screen.queryByText('user_1 was created')).toBeNull()
    expect(screen.queryByText('by owner_1')).toBeNull()
    expect(screen.queryByText('Role: viewer')).toBeNull()
    expect(calls).not.toContain('GET /admin/api/cms/users')
    expect(calls).not.toContain('GET /admin/api/cms/roles')
    expect(calls).toContain('GET /admin/api/cms/audit')
  })

  it('renders the audit empty state when the audit feed is empty', async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/audit' && init?.method === 'GET') return json({ events: [] })
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper user={currentUser(['audit.read'])}>
        <UsersPage />
      </Wrapper>,
    )

    expect(await screen.findByText('No audit events yet.')).toBeDefined()
    expect(screen.queryByRole('table', { name: 'Audit events' })).toBeNull()
  })

  it('surfaces audit API load failures to audit readers', async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/audit' && init?.method === 'GET') {
        return json({ error: 'Audit service unavailable' }, 503)
      }
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper user={currentUser(['audit.read'])}>
        <UsersPage />
      </Wrapper>,
    )

    expect((await screen.findByRole('alert')).textContent).toContain('Audit service unavailable')
    expect(screen.getByText('No audit events yet.')).toBeDefined()
  })

  it('locks the owner row and exposes edit/reset actions for regular users', async () => {
    render(
      <Wrapper user={currentUser(['users.manage', 'roles.manage', 'audit.read'])}>
        <UsersPage />
      </Wrapper>,
    )

    expect(screen.queryByRole('heading', { name: 'Create User' })).toBeNull()
    const usersTable = await screen.findByRole('table', { name: 'Users' })
    expect(usersTable.getAttribute('data-density')).toBe('compact')

    const ownerRow = await screen.findByLabelText('User hello@davidbabinec.com')
    expect(within(ownerRow).queryByRole('button', { name: /suspend/i })).toBeNull()
    expect(within(ownerRow).queryByRole('button', { name: /delete/i })).toBeNull()
    expect(within(ownerRow).queryByRole('button', { name: /reset/i })).toBeNull()
    expect(within(ownerRow).queryByRole('button', { name: /actions/i })).toBeNull()
    expect(within(ownerRow).queryByRole('combobox')).toBeNull()
    expect(within(ownerRow).getByText('Owner account')).toBeDefined()
    expect(within(ownerRow).getByText('Owner account').getAttribute('data-accent')).toBeTruthy()

    const userRow = screen.getByLabelText('User test@test.com')
    expect(within(userRow).getByText('Active').getAttribute('data-accent')).toBeTruthy()
    expect(within(userRow).getByText('Member').getAttribute('data-accent')).toBeTruthy()
    expect(within(userRow).queryByRole('button', { name: /edit tester one/i })).toBeNull()
    expect(within(userRow).queryByRole('button', { name: /reset password for tester one/i })).toBeNull()
    expect(within(userRow).queryByRole('button', { name: /suspend tester one/i })).toBeNull()
    expect(within(userRow).queryByRole('button', { name: /delete tester one/i })).toBeNull()

    fireEvent.click(within(userRow).getByRole('button', { name: /actions for tester one/i }))
    const userMenu = screen.getByRole('menu', { name: 'User actions for Tester One' })
    expect(within(userMenu).getByRole('menuitem', { name: 'Edit' })).toBeDefined()
    expect(within(userMenu).getByRole('menuitem', { name: 'Reset password' })).toBeDefined()
    expect(within(userMenu).getByRole('menuitem', { name: 'Suspend' })).toBeDefined()
    expect(within(userMenu).getByRole('menuitem', { name: 'Delete' })).toBeDefined()

    fireEvent.click(within(userMenu).getByRole('menuitem', { name: 'Edit' }))
    const editDialog = screen.getByRole('dialog', { name: 'Edit User' })
    expect(within(editDialog).getByDisplayValue('test@test.com')).toBeDefined()

    fireEvent.click(within(editDialog).getByRole('button', { name: 'Close dialog' }))
    fireEvent.click(within(userRow).getByRole('button', { name: /actions for tester one/i }))
    const resetMenu = screen.getByRole('menu', { name: 'User actions for Tester One' })
    fireEvent.click(within(resetMenu).getByRole('menuitem', { name: 'Reset password' }))
    const resetDialog = screen.getByRole('dialog', { name: 'Reset Password' })
    expect(within(resetDialog).getByLabelText('New password')).toBeDefined()

    fireEvent.click(within(resetDialog).getByRole('button', { name: 'Close dialog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create User' }))
    const createDialog = screen.getByRole('dialog', { name: 'Create User' })
    expect(within(createDialog).getByLabelText('Email')).toBeDefined()
  })

  it('renders roles as a compact table and keeps full capability details in a dialog', async () => {
    render(
      <Wrapper user={currentUser(['users.manage', 'roles.manage', 'audit.read'])}>
        <UsersPage />
      </Wrapper>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Roles' }))

    expect(screen.queryByRole('heading', { name: 'Create Role' })).toBeNull()
    const rolesTable = await screen.findByRole('table', { name: 'Roles' })
    expect(rolesTable.getAttribute('data-density')).toBe('compact')

    const adminRole = await screen.findByLabelText('Role Admin')
    expect(within(adminRole).getByText('Admin')).toBeDefined()
    expect(within(adminRole).queryByText('admin')).toBeNull()
    expect(within(adminRole).getByText('Full admin access.')).toBeDefined()
    expect(within(adminRole).getByText('11 capabilities')).toBeDefined()
    expect(within(adminRole).queryByText('Plugins')).toBeNull()
    expect(within(adminRole).queryByText('Users & Roles')).toBeNull()
    expect(within(adminRole).queryByText('plugins.read')).toBeNull()
    expect(within(adminRole).queryByText('users.manage')).toBeNull()
    expect(within(adminRole).getByText('System role').getAttribute('data-accent')).toBeTruthy()
    expect(within(adminRole).queryByRole('button', { name: /edit/i })).toBeNull()
    expect(within(adminRole).queryByRole('button', { name: /delete/i })).toBeNull()
    expect(within(adminRole).queryByRole('button', { name: /view admin/i })).toBeNull()
    fireEvent.click(within(adminRole).getByRole('button', { name: /actions for admin/i }))
    const adminMenu = screen.getByRole('menu', { name: 'Role actions for Admin' })
    expect(within(adminMenu).getByRole('menuitem', { name: 'View' })).toBeDefined()
    // Non-owner system roles are now editable (by anyone with roles.manage)
    // — only Owner is locked. Delete remains hidden for every system role.
    expect(within(adminMenu).getByRole('menuitem', { name: 'Edit' })).toBeDefined()
    expect(within(adminMenu).queryByRole('menuitem', { name: 'Delete' })).toBeNull()

    const customRole = screen.getByLabelText('Role Ops')
    expect(within(customRole).getByText('Can manage plugins and media.')).toBeDefined()
    expect(within(customRole).getByText('5 capabilities')).toBeDefined()
    expect(within(customRole).queryByText('plugins.read')).toBeNull()
    expect(within(customRole).queryByRole('button', { name: /view ops/i })).toBeNull()
    expect(within(customRole).queryByRole('button', { name: /edit ops/i })).toBeNull()
    expect(within(customRole).queryByRole('button', { name: /delete ops/i })).toBeNull()
    fireEvent.click(within(customRole).getByRole('button', { name: /actions for ops/i }))
    const customRoleMenu = screen.getByRole('menu', { name: 'Role actions for Ops' })
    expect(within(customRoleMenu).getByRole('menuitem', { name: 'View' })).toBeDefined()
    expect(within(customRoleMenu).getByRole('menuitem', { name: 'Edit' })).toBeDefined()
    expect(within(customRoleMenu).getByRole('menuitem', { name: 'Delete' })).toBeDefined()

    fireEvent.click(within(adminMenu).getByRole('menuitem', { name: 'View' }))
    const viewRoleDialog = screen.getByRole('dialog', { name: 'View Role' })
    // Admin row carries the split plugin caps; the picker shows their labels.
    expect(within(viewRoleDialog).getByText('Browse installed plugins')).toBeDefined()
    expect(within(viewRoleDialog).getByText('Manage users')).toBeDefined()
    expect(within(viewRoleDialog).queryByRole('button', { name: /save role/i })).toBeNull()

    fireEvent.click(within(viewRoleDialog).getByRole('button', { name: 'Close dialog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }))
    const createRoleDialog = screen.getByRole('dialog', { name: 'Create Role' })
    expect(within(createRoleDialog).getByText('Site')).toBeDefined()
    expect(within(createRoleDialog).getByRole('button', { name: 'Select all Site capabilities' })).toBeDefined()
  })

  it('renders audit events as human-readable activity rows', async () => {
    render(
      <Wrapper user={currentUser(['users.manage', 'roles.manage', 'audit.read'])}>
        <UsersPage />
      </Wrapper>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Audit' }))

    const auditTable = await screen.findByRole('table', { name: 'Audit events' })
    expect(auditTable.getAttribute('data-density')).toBe('compact')
    expect(screen.getByText('Tester One was created')).toBeDefined()
    expect(screen.getAllByText('by hello@davidbabinec.com').length).toBeGreaterThan(0)
    expect(screen.getByText('Role: Member').getAttribute('data-accent')).toBeTruthy()
    expect(screen.getByText('IP: 127.0.0.1').getAttribute('data-accent')).toBeTruthy()
    expect(screen.getByText('Failed login for missing@example.com')).toBeDefined()
    expect(screen.queryByText('IP: unknown')).toBeNull()
    expect(screen.queryByText('user.create')).toBeNull()
  })
})
