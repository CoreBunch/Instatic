import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import React, { type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from '@admin/lib/routing'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { DataPage } from '@admin/pages/data/DataPage'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../../fixtures'
import { CORE_CAPABILITIES } from '@core/capabilities'
import type { CmsCurrentUser } from '@core/persistence'

const originalFetch = globalThis.fetch
const now = '2026-06-10T10:00:00.000Z'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function adminUser(): CmsCurrentUser {
  return {
    id: 'data-admin',
    email: 'admin@example.com',
    displayName: 'Admin',
    status: 'active',
    role: {
      id: 'owner',
      slug: 'owner',
      name: 'Owner',
      description: '',
      isSystem: true,
      capabilities: [...CORE_CAPABILITIES],
    },
    capabilities: [...CORE_CAPABILITIES],
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

function Providers({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/admin/data']}>
      <AdminSessionProvider user={adminUser()}>
        <StepUpProvider>{children}</StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>
  )
}

function setupEditorShell(): void {
  const site = makeSite({ name: 'Data Shell Site' })
  useEditorStore.setState({
    site,
    activePageId: site.pages[0].id,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    leftSidebarWidth: 320,
    dataSidebarCollapsed: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('Data table step-up flow', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    setupEditorShell()
  })

  afterEach(() => {
    cleanup()
    globalThis.fetch = originalFetch
  })

  it('opens the shared step-up dialog and retries when creating a custom table requires step-up', async () => {
    let createAttempts = 0
    const stepUpRequests: Array<Record<string, unknown>> = []

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/admin/api/cms/data/tables' && init?.method !== 'POST') {
        return json({
          tables: [{
            id: 'components',
            name: 'Components',
            slug: 'components',
            kind: 'component',
            routeBase: '',
            singularLabel: 'Component',
            pluralLabel: 'Components',
            primaryFieldId: 'name',
            fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
            system: true,
            rowCount: 0,
            createdByUserId: null,
            updatedByUserId: null,
            createdAt: now,
            updatedAt: now,
          }],
        })
      }

      if (url === '/admin/api/cms/data/tables/components/rows' && init?.method === 'GET') {
        return json({ rows: [] })
      }

      if (url === '/admin/api/cms/data/tables/custom-table/rows' && init?.method === 'GET') {
        return json({ rows: [] })
      }

      if (url === '/admin/api/cms/data/tables' && init?.method === 'POST') {
        createAttempts += 1
        if (createAttempts === 1) return json({ error: 'step_up_required' }, 401)
        return json({
          table: {
            id: 'custom-table',
            name: 'custom table',
            slug: 'custom-table',
            kind: 'data',
            routeBase: '',
            singularLabel: 'custom table',
            pluralLabel: 'custom tables',
            primaryFieldId: 'name',
            fields: [{ type: 'text', id: 'name', label: 'Name', required: true }],
            system: false,
            createdByUserId: 'data-admin',
            updatedByUserId: 'data-admin',
            createdAt: now,
            updatedAt: now,
          },
        }, 201)
      }

      if (url === '/admin/api/cms/auth/step-up' && init?.method === 'POST') {
        stepUpRequests.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json({ ok: true, stepUpExpiresAt: '2026-06-10T10:15:00.000Z' })
      }

      if (url.endsWith('/admin/api/cms/plugins')) return json({ plugins: [], adminPages: [] })
      if (url.endsWith('/admin/api/cms/site')) return json({ site: null }, 404)
      if (url.endsWith('/admin/api/cms/publish/status')) return json({ ok: false }, 404)

      return json({ error: `Unhandled ${url}` }, 500)
    }) as typeof fetch

    render(
      <Providers>
        <DataPage />
      </Providers>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'New table' }))
    const dialog = await screen.findByRole('dialog', { name: 'New table' })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'custom table' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await screen.findByTestId('step-up-dialog')).toBeTruthy()
    expect(screen.queryByText('step_up_required')).toBeNull()

    fireEvent.change(screen.getByTestId('step-up-password'), {
      target: { value: 'long-enough-password' },
    })
    fireEvent.click(screen.getByTestId('step-up-confirm'))

    await waitFor(() => {
      expect(createAttempts).toBe(2)
    })
    expect(stepUpRequests).toEqual([{ password: 'long-enough-password' }])
    expect(screen.queryByTestId('step-up-dialog')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'New table' })).toBeNull()
    expect(await screen.findByRole('option', { name: /custom tables/i })).toBeTruthy()
  })
})
