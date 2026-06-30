import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from '@admin/lib/routing'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { ContentPage } from '@content/ContentPage'
import type { CmsCurrentUser } from '@core/persistence'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

const originalFetch = globalThis.fetch
const now = '2026-05-07T10:00:00.000Z'

function currentUser(capabilities: string[]): CmsCurrentUser {
  return {
    id: 'editor_1',
    email: 'editor@example.com',
    displayName: 'Editor',
    status: 'active',
    role: {
      // Synthetic role used to wire `capabilities` into the mock user — the
      // role's slug doesn't need to match a real system role, this test
      // doesn't hit the role registry.
      id: 'test-role',
      slug: 'test-role',
      name: 'Test Role',
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeTable(id: string, name: string, slug: string) {
  return {
    id,
    name,
    slug,
    kind: 'postType',
    routeBase: `/${slug}`,
    singularLabel: name.replace(/s$/, ''),
    pluralLabel: name,
    primaryFieldId: 'title',
    system: id === 'posts' || id === 'pages' || id === 'components',
    rowCount: 0,
    fields: [
      { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
      { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
      { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
      { type: 'media', id: 'featuredMedia', label: 'Featured media', mediaKind: 'image', builtIn: true },
      { type: 'text', id: 'seoTitle', label: 'SEO title', builtIn: true },
      { type: 'longText', id: 'seoDescription', label: 'SEO description', builtIn: true },
    ],
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
  }
}

function makeRow(
  id: string,
  tableId: string,
  cells: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const mergedCells: Record<string, unknown> = {
    title: '',
    slug: 'untitled',
    body: '',
    featuredMedia: null,
    seoTitle: '',
    seoDescription: '',
    ...cells,
  }
  return {
    id,
    tableId,
    cells: mergedCells,
    slug: typeof mergedCells.slug === 'string' ? mergedCells.slug : 'untitled',
    status: 'draft',
    authorUserId: null as string | null,
    createdByUserId: null as string | null,
    updatedByUserId: null as string | null,
    publishedByUserId: null as string | null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null as string | null,
    scheduledPublishAt: null as string | null,
    deletedAt: null as string | null,
    ...overrides,
  }
}

function setupEditorState() {
  const site = makeSite({ name: 'Capability Site' })
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

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('capability-aware admin UI', () => {
  it('hides admin sections that the current user cannot access', () => {
    render(
      <MemoryRouter initialEntries={['/admin/content']}>
        <AdminSessionProvider user={currentUser(['content.create', 'content.edit.own', 'content.publish.own'])}>
          <AdminSectionNavigation section="content" />
        </AdminSessionProvider>
      </MemoryRouter>,
    )

    expect(screen.getByText('Content')).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Site' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Plugins' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull()
  })

  it('removes collection management and author reassignment for own-content editors', async () => {
    setupEditorState()
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      if (url === '/admin/api/cms/data/tables') {
        return json({ tables: [makeTable('posts', 'Posts', 'posts')] })
      }
      if (url === '/admin/api/cms/data/tables/posts/rows' && method === 'GET') {
        return json({
          rows: [makeRow('entry_1', 'posts', {
            title: 'Own draft',
            slug: 'own-draft',
          }, {
            authorUserId: 'editor_1',
            author: { id: 'editor_1', email: 'editor@example.com', displayName: 'Editor', roleSlug: 'editor', roleName: 'Editor' },
            createdByUserId: 'editor_1',
            updatedByUserId: 'editor_1',
          })],
        })
      }
      if (url === '/admin/api/cms/media') return json({ assets: [] })
      if (url.endsWith('/admin/api/cms/plugins')) return json({ plugins: [], adminPages: [] })
      if (url.endsWith('/admin/api/cms/site')) return json({ site: null }, 404)
      if (url.endsWith('/admin/api/cms/publish/status')) return json({ ok: false }, 404)
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <MemoryRouter>
        <AdminSessionProvider user={currentUser(['content.create', 'content.edit.own', 'content.publish.own'])}>
          <StepUpProvider>
            <ContentPage />
          </StepUpProvider>
        </AdminSessionProvider>
      </MemoryRouter>,
    )

    const explorer = await screen.findByTestId('content-explorer-panel')
    expect(within(explorer).queryByRole('button', { name: /new collection/i })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Author' })).toBeNull()

    fireEvent.contextMenu(await within(explorer).findByRole('button', { name: /own draft draft/i }))
    const menu = screen.getByRole('menu', { name: 'Content item options' })
    expect(within(menu).getByRole('menuitem', { name: 'Publish' })).toBeDefined()
    expect(within(menu).queryByRole('menuitem', { name: 'Move to collection' })).toBeNull()
    expect(calls).not.toContainEqual({
      url: '/admin/api/cms/data/authors',
      method: 'GET',
    })
  })

  it('publishes owned entries from settings without requiring edit rights', async () => {
    setupEditorState()
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method })

      if (url === '/admin/api/cms/data/tables') {
        return json({ tables: [makeTable('posts', 'Posts', 'posts')] })
      }

      if (url === '/admin/api/cms/data/tables/posts/rows' && method === 'GET') {
        return json({
          rows: [makeRow('entry_1', 'posts', {
            title: 'Publishable draft',
            slug: 'publishable-draft',
          }, {
            authorUserId: 'editor_1',
            author: { id: 'editor_1', email: 'editor@example.com', displayName: 'Editor', roleSlug: 'editor', roleName: 'Editor' },
            createdByUserId: 'editor_1',
            updatedByUserId: 'editor_1',
          })],
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_1/publish' && method === 'POST') {
        return json({
          row: makeRow('entry_1', 'posts', {
            title: 'Publishable draft',
            slug: 'publishable-draft',
          }, {
            status: 'published',
            authorUserId: 'editor_1',
            author: { id: 'editor_1', email: 'editor@example.com', displayName: 'Editor', roleSlug: 'editor', roleName: 'Editor' },
            createdByUserId: 'editor_1',
            updatedByUserId: 'editor_1',
            publishedByUserId: 'editor_1',
            updatedAt: now,
            publishedAt: now,
          }),
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_1' && method === 'PATCH') {
        return json({ error: 'edit forbidden' }, 403)
      }

      if (url.endsWith('/admin/api/cms/plugins')) return json({ plugins: [], adminPages: [] })
      if (url.endsWith('/admin/api/cms/site')) return json({ site: null }, 404)
      if (url.endsWith('/admin/api/cms/publish/status')) return json({ ok: false }, 404)
      return json({ error: `Unhandled ${method} ${url}` }, 500)
    }

    render(
      <MemoryRouter>
        <AdminSessionProvider user={currentUser(['content.publish.own'])}>
          <StepUpProvider>
            <ContentPage />
          </StepUpProvider>
        </AdminSessionProvider>
      </MemoryRouter>,
    )

    const statusSelect = await screen.findByLabelText('Status')
    expect((screen.getByLabelText('Title') as HTMLTextAreaElement).disabled).toBe(true)

    fireEvent.change(statusSelect, { target: { value: 'published' } })

    await screen.findByText('Published')
    expect(calls).toContainEqual({
      url: '/admin/api/cms/data/rows/entry_1/publish',
      method: 'POST',
    })
    expect(calls).not.toContainEqual({
      url: '/admin/api/cms/data/rows/entry_1',
      method: 'PATCH',
    })
  })
})
