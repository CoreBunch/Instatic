import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React, { type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from '@admin/lib/routing'
import { PluginsPage } from '@plugins/PluginsPage'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { useEditorStore } from '@site/store/store'
import type { CmsCurrentUser } from '@core/persistence'
import { makeSite } from '../fixtures'

const originalFetch = globalThis.fetch

const mapManifest = {
  id: 'local.map',
  name: 'Map Studio',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['admin.navigation'],
  adminPages: [{
    id: 'overview',
    title: 'Map Studio',
    navLabel: 'Map',
    icon: 'map',
    route: '/admin/plugins/local.map/overview',
    content: {
      kind: 'map',
      heading: 'Store Map',
      body: 'Track important locations.',
      centerLabel: 'Prague',
      pins: [{ label: 'HQ', detail: 'Main office', x: 42, y: 55 }],
    },
  }],
}

function pluginRow(enabled = true, overrides: Record<string, unknown> = {}) {
  return {
    id: mapManifest.id,
    name: mapManifest.name,
    version: mapManifest.version,
    enabled,
    lifecycleStatus: enabled ? 'active' : 'disabled',
    lastError: null,
    grantedPermissions: [],
    manifest: mapManifest,
    installedAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  }
}

function setupEditorState() {
  const site = makeSite({ name: 'Plugin Shell Site' })
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Ambient fetch fallback for endpoints AdminPageLayout calls on mount that
 * the PluginsPage tests don't otherwise care about (site load,
 * publish-status). The plugins-list endpoint is owned by each test, so it's
 * intentionally NOT in here.
 */
function ambientFetchFallback(url: string): Response | undefined {
  if (url.endsWith('/admin/api/cms/site')) {
    return json({ site: null }, 404)
  }
  if (url.endsWith('/admin/api/cms/site/publish-status')) {
    return json({ ok: false }, 404)
  }
  return undefined
}

const now = '2026-05-07T10:00:00.000Z'

function adminUser(): CmsCurrentUser {
  return {
    id: 'plugin-manager',
    email: 'admin@example.com',
    displayName: 'Plugin Manager',
    status: 'active',
    role: {
      id: 'admin',
      slug: 'admin',
      name: 'Admin',
      description: '',
      isSystem: true,
      capabilities: ['site.read', 'site.structure.edit','site.content.edit','site.style.edit', 'plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle'],
    },
    capabilities: ['site.read', 'site.structure.edit','site.content.edit','site.style.edit', 'plugins.read', 'plugins.configure', 'plugins.install', 'plugins.lifecycle'],
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

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <AdminSessionProvider user={adminUser()}>
        <StepUpProvider>{children}</StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  localStorage.clear()
  setupEditorState()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('PluginsPage', () => {
  it('lists active plugins and can disable or remove them', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)
      if (url === '/admin/api/cms/plugins' && init?.method === 'GET') {
        return json({
          plugins: [pluginRow(true)],
          adminPages: [{ pluginId: 'local.map', pluginName: 'Map Studio', ...mapManifest.adminPages[0] }],
        })
      }
      if (url === '/admin/api/cms/plugins/local.map' && init?.method === 'PATCH') {
        return json({ plugin: pluginRow(false), adminPages: [] })
      }
      if (url === '/admin/api/cms/plugins/local.map' && init?.method === 'DELETE') {
        return json({ ok: true })
      }
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper>
        <PluginsPage />
      </Wrapper>,
    )

    expect(await screen.findByText('Map Studio')).toBeDefined()
    expect(screen.getAllByRole('link', { name: 'Map' })[0].getAttribute('href')).toBe('/admin/plugins/local.map/overview')

    fireEvent.click(screen.getByRole('button', { name: /disable map studio/i }))
    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/plugins/local.map' &&
        call.init?.method === 'PATCH' &&
        call.init.body === JSON.stringify({ enabled: false })
      )).toBe(true)
    })

    fireEvent.click(screen.getByRole('button', { name: /remove map studio/i }))

    // Removal is gated by `<PluginRemoveDialog/>` — clicking Remove on the
    // card opens the confirm dialog; the actual DELETE only fires after
    // the user confirms inside the dialog.
    const confirm = await screen.findByRole('button', { name: 'Remove plugin' })
    fireEvent.click(confirm)

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/plugins/local.map' &&
        call.init?.method === 'DELETE'
      )).toBe(true)
    })
  })

  it('uploads a JSON plugin manifest', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)
      if (url === '/admin/api/cms/plugins' && init?.method === 'GET') {
        return json({ plugins: [], adminPages: [] })
      }
      if (url === '/admin/api/cms/plugins' && init?.method === 'POST') {
        return json({ plugin: pluginRow(true), adminPages: [] }, 201)
      }
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper>
        <PluginsPage />
      </Wrapper>,
    )

    expect(await screen.findByText('No plugins installed yet.')).toBeDefined()

    const input = screen.getByLabelText('Plugin file')
    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(mapManifest)], 'map-studio.plugin.json', { type: 'application/json' })],
      },
    })

    // Every install now goes through the review dialog — nothing installs
    // silently, even a near-declarative manifest.
    expect(await screen.findByText('Review Map Studio')).toBeDefined()
    expect(calls.some((call) => String(call.input) === '/admin/api/cms/plugins' && call.init?.method === 'POST')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /approve and install/i }))

    await waitFor(() => {
      const installCall = calls.find((call) =>
        String(call.input) === '/admin/api/cms/plugins' &&
        call.init?.method === 'POST'
      )
      expect(installCall).toBeDefined()
      expect(JSON.parse(String(installCall?.init?.body))).toMatchObject({
        manifest: { id: 'local.map' },
        grantedPermissions: ['admin.navigation'],
      })
    })
  })

  it('asks for permission approval before installing privileged plugins', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const privilegedManifest = {
      ...mapManifest,
      id: 'acme.workflow',
      name: 'Workflow Tools',
      permissions: ['admin.navigation', 'editor.code', 'editor.toolbar', 'editor.commands', 'editor.store.write', 'cms.storage'],
      entrypoints: { editor: 'editor/index.js' },
    }

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)
      if (url === '/admin/api/cms/plugins' && init?.method === 'GET') {
        return json({ plugins: [], adminPages: [] })
      }
      if (url === '/admin/api/cms/plugins' && init?.method === 'POST') {
        return json({ plugin: pluginRow(true), adminPages: [] }, 201)
      }
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper>
        <PluginsPage />
      </Wrapper>,
    )

    expect(await screen.findByText('No plugins installed yet.')).toBeDefined()

    fireEvent.change(screen.getByLabelText('Plugin file'), {
      target: {
        files: [new File([JSON.stringify(privilegedManifest)], 'workflow.plugin.json', { type: 'application/json' })],
      },
    })

    expect(await screen.findByText('Review Workflow Tools')).toBeDefined()
    expect(screen.getByText('Add controls to the editor toolbar')).toBeDefined()
    expect(screen.getByText('Register editor commands')).toBeDefined()
    expect(screen.getByText('Allows the plugin to mutate editor store state through a host transaction.')).toBeDefined()
    expect(calls.some((call) => String(call.input) === '/admin/api/cms/plugins' && call.init?.method === 'POST')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /approve and install/i }))

    await waitFor(() => {
      const installCall = calls.find((call) =>
        String(call.input) === '/admin/api/cms/plugins' &&
        call.init?.method === 'POST'
      )
      expect(installCall).toBeDefined()
      expect(JSON.parse(String(installCall?.init?.body))).toMatchObject({
        manifest: { id: 'acme.workflow' },
        grantedPermissions: privilegedManifest.permissions,
      })
    })
  })

  it('offers force-remove after a hook-failed uninstall and confirms before forcing', async () => {
    const hookError =
      'Plugin uninstall hook failed during uninstall: uninstall exploded — the plugin is still installed. Fix the plugin, or force-remove it to skip its cleanup hooks.'
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)
      if (url === '/admin/api/cms/plugins' && init?.method === 'GET') {
        return json({ plugins: [pluginRow(true)], adminPages: [] })
      }
      if (url === '/admin/api/cms/plugins/local.map' && init?.method === 'DELETE') {
        return json({ error: hookError }, 400)
      }
      if (url === '/admin/api/cms/plugins/local.map?force=true' && init?.method === 'DELETE') {
        return json({ ok: true })
      }
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper>
        <PluginsPage />
      </Wrapper>,
    )

    expect(await screen.findByText('Map Studio')).toBeDefined()

    // Normal removal: card button → confirm dialog → DELETE fails with the
    // hook error.
    fireEvent.click(screen.getByRole('button', { name: /remove map studio/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove plugin' }))

    // Failure surfaces as an alert with the server message and a
    // "Remove anyway" escape hatch.
    expect(await screen.findByText(hookError)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))

    // Force-removal is gated by its own confirmation dialog with skip-hooks
    // warning copy — the forced DELETE only fires after confirming there.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/cleanup code will be skipped/i)).toBeDefined()
    expect(
      calls.some((call) => String(call.input) === '/admin/api/cms/plugins/local.map?force=true'),
    ).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove anyway' }))

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/plugins/local.map?force=true' &&
        call.init?.method === 'DELETE'
      )).toBe(true)
    })
  })

  it('shows lifecycle error diagnostics for failed plugin hooks', async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/plugins' && init?.method === 'GET') {
        return json({
          plugins: [pluginRow(true, {
            lifecycleStatus: 'error',
            lastError: 'install exploded',
          })],
          adminPages: [],
        })
      }
      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <Wrapper>
        <PluginsPage />
      </Wrapper>,
    )

    expect(await screen.findByText('Map Studio')).toBeDefined()
    expect(screen.getByText('Error')).toBeDefined()
    expect(screen.getByText('install exploded')).toBeDefined()
  })
})
