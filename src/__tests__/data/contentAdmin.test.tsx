import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React, { type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from '@admin/lib/routing'
import { useLocation } from '@admin/lib/routing'
import { ContentPage } from '@content/ContentPage'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { useAdminUi } from '@admin/state/adminUi'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'
import { Toolbar } from '@site/toolbar/Toolbar'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import type { CmsCurrentUser } from '@core/persistence'
import { CORE_CAPABILITIES } from '@core/capabilities'
import { executeContentTool } from '@content/agent/contentBridge'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'

const originalFetch = globalThis.fetch

const imageAsset = {
  id: 'asset_image_1',
  filename: 'hero.png',
  publicPath: '/uploads/hero.png',
  mimeType: 'image/png',
  sizeBytes: 2048,
  width: 1200,
  height: 800,
  durationSeconds: null,
  uploadedByUserId: null,
  createdAt: '2026-05-01T10:00:00.000Z',
}

const videoAsset = {
  id: 'asset_video_1',
  filename: 'intro.mp4',
  publicPath: '/uploads/intro.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 4096,
  width: 1920,
  height: 1080,
  durationSeconds: 12,
  uploadedByUserId: null,
  createdAt: '2026-05-01T10:05:00.000Z',
}

const allBuiltInFields = [
  { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
  { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
  { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
  { type: 'media', id: 'featuredMedia', label: 'Featured media', mediaKind: 'image', builtIn: true },
  { type: 'text', id: 'seoTitle', label: 'SEO title', builtIn: true },
  { type: 'longText', id: 'seoDescription', label: 'SEO description', builtIn: true },
]

const titleOnlyFields = [
  { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
  { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
]

const ownerAuthor = {
  id: 'user_owner',
  email: 'owner@example.com',
  displayName: 'Owner Name',
  roleSlug: 'owner',
  roleName: 'Owner',
}

const editorAuthor = {
  id: 'user_editor',
  email: 'editor@example.com',
  displayName: 'Editor Name',
  roleSlug: 'editor',
  roleName: 'Editor',
}

const adminAuthor = {
  id: 'user_admin',
  email: 'admin@example.com',
  displayName: 'Admin Name',
  roleSlug: 'admin',
  roleName: 'Admin',
}

function makeTable(
  id: string,
  name: string,
  slug: string,
  routeBase: string,
  singularLabel: string,
  pluralLabel: string,
  fields: unknown[] = allBuiltInFields,
) {
  return {
    id,
    name,
    slug,
    kind: 'postType',
    routeBase,
    singularLabel,
    pluralLabel,
    primaryFieldId: 'title',
    fields,
    system: id === 'posts' || id === 'pages' || id === 'components',
    rowCount: 0,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
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
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    publishedAt: null as string | null,
    scheduledPublishAt: null as string | null,
    deletedAt: null as string | null,
    ...overrides,
  }
}

interface FetchCall {
  input: RequestInfo | URL
  init?: RequestInit
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Ambient fetch fallback for endpoints the shared Toolbar / AdminCanvasLayout
 * fire on mount (plugin list, draft site, publish status). Returns
 * `undefined` for non-ambient URLs so per-test handlers stay authoritative.
 */
function ambientFetchFallback(url: string): Response | undefined {
  if (url.endsWith('/admin/api/cms/plugins')) {
    return json({ plugins: [], adminPages: [] })
  }
  if (url.endsWith('/admin/api/cms/site')) {
    return json({ site: makeSite({ name: 'Content Shell Site' }) })
  }
  if (
    url.endsWith('/admin/api/cms/pages') ||
    url.endsWith('/admin/api/cms/components') ||
    url.endsWith('/admin/api/cms/layouts')
  ) {
    return json({ rows: [] })
  }
  if (url.endsWith('/admin/api/cms/publish/status')) {
    return json({ ok: false }, 404)
  }
  // The shared MediaPickerModal (workspace modal that replaced the old
  // inline MediaPickerDialog) loads folders alongside assets on mount.
  // Without this fallback the modal's workspace hook errors out and the
  // asset grid never renders.
  if (url.endsWith('/admin/api/cms/media/folders')) {
    return json({ folders: [] })
  }
  return undefined
}

function LocationProbe() {
  const location = useLocation()
  return <output aria-label="current route">{location.pathname}</output>
}

const now = '2026-05-07T10:00:00.000Z'

function contentEditorUser(): CmsCurrentUser {
  return {
    id: 'content-editor',
    email: 'editor@example.com',
    displayName: 'Editor',
    status: 'active',
    role: {
      id: 'admin',
      slug: 'admin',
      name: 'Admin',
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

function contentEditorWithoutAiChat(): CmsCurrentUser {
  const base = contentEditorUser()
  const capabilities = base.capabilities.filter((capability) => capability !== 'ai.chat')
  return {
    ...base,
    capabilities,
    role: {
      ...base.role,
      capabilities,
    },
  }
}

/**
 * Wraps test renders in the same provider stack production uses:
 *   MemoryRouter -> AdminSessionProvider -> StepUpProvider
 *
 * The shared Toolbar and AdminPageLayout require all three (router hooks,
 * AccountMenuButton -> useStepUp + useAuthenticatedAdminUser).
 */
function AdminTestProviders({
  initialEntries,
  user,
  children,
}: {
  initialEntries?: string[]
  user?: CmsCurrentUser
  children: ReactNode
}) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <AdminSessionProvider user={user ?? contentEditorUser()}>
        <StepUpProvider>{children}</StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>
  )
}

function clickToolbarSaveDraft() {
  fireEvent.click(screen.getByRole('button', { name: /more publishing actions/i }))
  const menu = screen.getByRole('menu', { name: /publishing actions/i })
  fireEvent.click(within(menu).getByRole('menuitem', { name: /save draft/i }))
}

function clickToolbarPublish() {
  fireEvent.click(screen.getByTestId('toolbar-publish-btn'))
}

beforeEach(() => {
  clearDataMetaCache()
  const site = makeSite({ name: 'Content Shell Site' })
  localStorage.clear()
  // The workspaces now mirror their selection into the URL (`?table=&row=`).
  // jsdom's location persists across tests in a file, so reset it here to
  // simulate a fresh navigation and stop one test's URL leaking into the next.
  window.history.replaceState({}, '', '/')
  useAdminUi.getState().setSiteSummary({
    name: site.name,
    faviconUrl: site.settings.faviconUrl ?? null,
  })
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
  useWorkspaceLayout.setState({
    leftSidebarWidth: 320,
    rightPanel: { collapsed: false, width: 360 },
    dataSidebarCollapsed: false,
  })

  const calls: FetchCall[] = []
  ;(globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls = calls

  // The posts-rows endpoint is STATEFUL, like the real server: a row created by
  // POST is visible to every later GET, and a deleted row is gone from it.
  //
  // A stateless `rows: []` made this mock lie about the one ordering the app is
  // allowed to produce. The workspace treats a list response as authoritative
  // unless the selected row changed *during* that request (see
  // useContentWorkspace.loadEntries) — correct, because a real GET issued after
  // a POST returns the new row. But the mock returned an empty list forever, so
  // whenever the initial list GET happened to be issued after the create, its
  // (bogus) empty response wiped the new row and the test failed. Which request
  // won that race was pure scheduling luck, making every create-then-assert test
  // in this file order-dependent.
  let postsRows: ReturnType<typeof makeRow>[] = []
  const putRow = (row: ReturnType<typeof makeRow>) => {
    const i = postsRows.findIndex((r) => r.id === row.id)
    if (i === -1) postsRows.push(row)
    else postsRows[i] = row
    return row
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    const url = String(input)

    if (url === '/admin/api/cms/data/tables') {
      return json({
        tables: [makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')],
      })
    }

    if (url === '/admin/api/cms/data/_meta') {
      return json({
        meta: {
          tables: [{
            id: 'posts',
            slug: 'posts',
            name: 'Posts',
            kind: 'postType',
            singularLabel: 'Post',
            pluralLabel: 'Posts',
            primaryFieldId: 'title',
            routable: true,
            versioned: true,
            fields: [
              { id: 'title', label: 'Title', type: 'text' },
              { id: 'body', label: 'Body', type: 'richText' },
              { id: 'seoTitle', label: 'SEO title', type: 'text' },
            ],
          }],
        },
      })
    }

    if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
      return json({ rows: postsRows })
    }

    if (url === '/admin/api/cms/data/authors' && init?.method === 'GET') {
      return json({ authors: [ownerAuthor, editorAuthor, adminAuthor] })
    }

    if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'POST') {
      return json({
        row: putRow(makeRow('entry_1', 'posts', { title: 'Untitled', slug: 'untitled' }, {
          authorUserId: ownerAuthor.id,
          author: ownerAuthor,
        })),
      }, 201)
    }

    if (url === '/admin/api/cms/data/rows/entry_1' && init?.method === 'PATCH') {
      const draft = JSON.parse(String(init.body))
      return json({
        row: putRow({
          ...makeRow('entry_1', 'posts', draft.cells ?? {}),
          updatedAt: '2026-05-01T10:01:00.000Z',
        }),
      })
    }

    if (url === '/admin/api/cms/data/rows/entry_1' && init?.method === 'DELETE') {
      postsRows = postsRows.filter((r) => r.id !== 'entry_1')
      return json({
        row: makeRow('entry_1', 'posts', { title: 'Untitled', slug: 'untitled' }, {
          authorUserId: ownerAuthor.id,
          author: ownerAuthor,
          deletedAt: '2026-05-01T10:01:00.000Z',
        }),
      })
    }

    if (url === '/admin/api/cms/data/rows/entry_1/publish' && init?.method === 'POST') {
      return json({
        row: putRow({
          ...makeRow('entry_1', 'posts', { title: 'My first post', slug: 'untitled', body: '## Intro', featuredMedia: null, seoTitle: '', seoDescription: '' }),
          status: 'published',
          updatedAt: '2026-05-01T10:02:00.000Z',
          publishedAt: '2026-05-01T10:02:00.000Z',
        }),
      })
    }

    if (url === '/admin/api/cms/data/rows/entry_1/status' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body))
      return json({
        row: putRow({
          ...makeRow('entry_1', 'posts', { title: 'My first post', slug: 'updated-slug', body: '', featuredMedia: imageAsset.id, seoTitle: '', seoDescription: '' }),
          status: body.status,
          updatedAt: '2026-05-01T10:03:00.000Z',
        }),
      })
    }

    if (url === '/admin/api/cms/media') {
      return json({ assets: [imageAsset, videoAsset] })
    }

    const ambient = ambientFetchFallback(url)
    if (ambient) return ambient

    return json({ error: `Unhandled ${url}` }, 500)
  }
})

afterEach(() => {
  clearDataMetaCache()
  globalThis.fetch = originalFetch
  useAdminUi.getState().setSiteSummary({ name: null, faviconUrl: null })
  cleanup()
})

describe('ContentPage', () => {
  it('uses SPA navigation with active Site and Content labels in the shared toolbar', () => {
    render(
      <AdminTestProviders initialEntries={['/admin/site']}>
        <Routes>
          <Route
            path="/admin/site"
            element={(
              <>
                <Toolbar
                  section="site"
                  adminNavigationSlot={<AdminSectionNavigation section="site" />}
                  rightSlot={<span>right</span>}
                />
                <LocationProbe />
              </>
            )}
          />
          <Route
            path="/admin/content"
            element={(
              <>
                <Toolbar
                  section="content"
                  adminNavigationSlot={<AdminSectionNavigation section="content" />}
                  rightSlot={<span>right</span>}
                />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </AdminTestProviders>,
    )

    expect(screen.getByText('Site')).toBeDefined()
    fireEvent.click(screen.getByRole('link', { name: 'Content' }))
    expect(screen.getByLabelText('current route').textContent).toBe('/admin/content')
    expect(screen.getByText('Content')).toBeDefined()
    expect(screen.getByRole('link', { name: 'Site' })).toBeDefined()
  })

  it('does not delay admin navigation or use route changes to collapse workspace panels', async () => {
    const transitionStarts: string[] = []

    render(
      <AdminTestProviders initialEntries={['/admin/site']}>
        <Routes>
          <Route
            path="/admin/site"
            element={(
              <>
                <Toolbar
                  section="site"
                  adminNavigationSlot={(
                    <AdminSectionNavigation
                      section="site"
                      onWorkspaceNavigateStart={() => {
                        transitionStarts.push('content')
                        return 180
                      }}
                    />
                  )}
                  rightSlot={<span>site controls</span>}
                />
                <LocationProbe />
              </>
            )}
          />
          <Route
            path="/admin/content"
            element={(
              <>
                <Toolbar
                  section="content"
                  adminNavigationSlot={<AdminSectionNavigation section="content" />}
                  rightSlot={<span>content controls</span>}
                />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </AdminTestProviders>,
    )

    fireEvent.click(screen.getByRole('link', { name: 'Content' }))

    expect(transitionStarts).toEqual(['content'])
    expect(screen.getByLabelText('current route').textContent).toBe('/admin/content')
    expect(screen.getByText('content controls')).toBeDefined()

    const layoutSource = readFileSync(join(process.cwd(), 'src/admin/layouts/AdminCanvasLayout/AdminCanvasLayout.tsx'), 'utf8')
    expect(layoutSource).not.toContain('setLeftSidebarPanel(null)')
    expect(layoutSource).not.toContain('setPropertiesPanel({ collapsed: true })')
    expect(layoutSource).not.toContain('onBeforeWorkspaceExit')
  })

  it('does not fade or view-transition the central canvas surface during admin navigation', () => {
    const layoutCss = readFileSync(join(process.cwd(), 'src/admin/layouts/AdminCanvasLayout/AdminCanvasLayout.module.css'), 'utf8')

    expect(layoutCss).not.toContain('admin-canvas-content')
    expect(layoutCss).not.toMatch(/\.canvasContent\s*\{[^}]*animation:/s)
  })

  it('waits for async workspace navigation hooks before changing routes', async () => {
    const transitionStarts: string[] = []
    let resolveNavigation: (() => void) | null = null

    render(
      <AdminTestProviders initialEntries={['/admin/site']}>
        <Routes>
          <Route
            path="/admin/site"
            element={(
              <>
                <Toolbar
                  section="site"
                  adminNavigationSlot={(
                    <AdminSectionNavigation
                      section="site"
                      onWorkspaceNavigateStart={() => new Promise<void>((resolve) => {
                        transitionStarts.push('content')
                        resolveNavigation = resolve
                      })}
                    />
                  )}
                  rightSlot={<span>site controls</span>}
                />
                <LocationProbe />
              </>
            )}
          />
          <Route
            path="/admin/content"
            element={(
              <>
                <Toolbar
                  section="content"
                  adminNavigationSlot={<AdminSectionNavigation section="content" />}
                  rightSlot={<span>content controls</span>}
                />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </AdminTestProviders>,
    )

    fireEvent.click(screen.getByRole('link', { name: 'Content' }))

    expect(transitionStarts).toEqual(['content'])
    expect(screen.getByLabelText('current route').textContent).toBe('/admin/site')
    expect(screen.getByText('site controls')).toBeDefined()

    resolveNavigation?.()

    await waitFor(() => {
      expect(screen.getByLabelText('current route').textContent).toBe('/admin/content')
    })
    expect(screen.getByText('content controls')).toBeDefined()
  })

  it('keeps loading skeletons visible until content entries finish loading', async () => {
    let resolveEntries: ((response: Response) => void) | null = null
    const entriesResponse = new Promise<Response>((resolve) => {
      resolveEntries = resolve
    })

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/admin/api/cms/data/tables') {
        return json({ tables: [makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')] })
      }

      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
        return entriesResponse
      }

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    expect(await screen.findByRole('region', { name: 'Posts' })).toBeDefined()
    expect(screen.getByTestId('content-entries-loading')).toBeDefined()
    expect(screen.getByTestId('content-canvas-loading')).toBeDefined()
    // Settings panel is entry-specific — it stays hidden until an entry is selected,
    // so no settings skeleton is shown during the initial entries load.
    expect(screen.queryByTestId('content-settings-panel')).toBeNull()
    expect(screen.queryByTestId('content-settings-loading')).toBeNull()
    expect(screen.queryByText('No entries yet.')).toBeNull()
    expect(screen.queryByText(/Create the first post/i)).toBeNull()

    resolveEntries?.(json({ rows: [] }))

    expect(await screen.findByText('No entries yet.')).toBeDefined()
    expect(await screen.findByText(/Create the first post/i)).toBeDefined()
  })

  it('mounts content inside the existing editor shell chrome', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    expect(await screen.findByTestId('toolbar')).toBeDefined()
    expect(screen.getByTestId('left-sidebar')).toBeDefined()
    expect(screen.getByTestId('right-sidebar')).toBeDefined()
    expect(screen.getByTestId('content-explorer-panel')).toBeDefined()
    expect(screen.getByTestId('content-canvas-root')).toBeDefined()
    // Settings panel is entry-specific — when no entry is selected, the panel is hidden.
    expect(screen.queryByTestId('content-settings-panel')).toBeNull()
    expect(screen.getByTestId('canvas-notch')).toBeDefined()
    expect(await screen.findByText('Content Shell Site')).toBeDefined()
  })

  it('keeps the site module picker out of the content insert notch', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    const notch = await screen.findByTestId('canvas-notch')

    expect(within(notch).getByRole('button', { name: 'Add Heading' })).toBeDefined()
    expect(within(notch).getByRole('button', { name: 'Add Text' })).toBeDefined()
    expect(within(notch).getByRole('button', { name: 'Add Media' })).toBeDefined()
    const tokenButton = within(notch).getByRole('button', { name: 'Add Insert data token' })
    expect(tokenButton).toBeDefined()
    expect(within(notch).queryByRole('button', { name: 'Add to canvas' })).toBeNull()
    expect(screen.queryByTestId('canvas-notch-add-btn')).toBeNull()

    fireEvent.click(tokenButton)

    expect(await screen.findByRole('menu', { name: 'Insert binding for Post body' })).toBeDefined()
    expect(await screen.findByText('Current entry — Posts')).toBeDefined()
    expect(screen.getByText('Title')).toBeDefined()
  })

  it('suppresses the token tooltip while open and inserts populated media and repeater fields', async () => {
    const defaultFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/data/_meta') {
        return json({
          meta: {
            tables: [{
              id: 'posts',
              slug: 'posts',
              name: 'Posts',
              kind: 'postType',
              singularLabel: 'Post',
              pluralLabel: 'Posts',
              primaryFieldId: 'title',
              routable: true,
              versioned: true,
              fields: [
                { id: 'title', label: 'Title', type: 'text' },
                {
                  id: 'heroImage',
                  label: 'Hero image',
                  type: 'media',
                  mediaKind: 'image',
                },
                {
                  id: 'featureRows',
                  label: 'Feature rows',
                  type: 'repeater',
                  itemLabelFieldId: 'heading',
                  fields: [
                    { id: 'heading', label: 'Heading', type: 'text' },
                    {
                      id: 'image',
                      label: 'Image',
                      type: 'media',
                      mediaKind: 'image',
                    },
                  ],
                },
              ],
            }],
          },
        })
      }
      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'POST') {
        return json({
          row: makeRow('entry_1', 'posts', {
            title: 'Untitled',
            slug: 'untitled',
            heroImage: imageAsset.id,
            featureRows: [
              {
                id: 'feature_1',
                cells: { heading: 'Fast', image: imageAsset.id },
              },
              {
                id: 'feature_2',
                cells: { heading: 'Flexible', image: imageAsset.id },
              },
            ],
          }),
        }, 201)
      }
      return defaultFetch(input, init)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )
    const bodyEditor = await screen.findByTestId('content-body-editor')
    const tokenButton = screen.getByRole('button', {
      name: 'Add Insert data token',
    })

    fireEvent.mouseEnter(tokenButton)
    expect(await screen.findByRole('tooltip')).toBeDefined()
    fireEvent.click(tokenButton)

    const picker = await screen.findByRole('menu', {
      name: 'Insert binding for Post body',
    })
    expect(screen.getByRole('button', {
      name: 'Add Insert data token',
    }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('tooltip')).toBeNull()

    const imageField = within(picker).getByRole('button', {
      name: /Hero image 1 image/i,
    })
    const repeaterField = within(picker).getByRole('button', {
      name: /Feature rows 2 items/i,
    })
    expect(imageField).toBeDefined()
    expect(repeaterField).toBeDefined()

    fireEvent.click(imageField)
    fireEvent.click(repeaterField)

    await waitFor(() => {
      expect(bodyEditor.textContent).toContain('{currentEntry.heroImage}')
      expect(bodyEditor.textContent).toContain('{currentEntry.featureRows}')
    })
    expect(screen.getByRole('menu', {
      name: 'Insert binding for Post body',
    })).toBeDefined()
  })

  it('hides the right settings panel until an entry is selected, then shows it', async () => {
    useWorkspaceLayout.setState({
      rightPanel: { collapsed: false, width: 360 },
    })

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    expect(await screen.findByRole('region', { name: 'Posts' })).toBeDefined()
    await screen.findByText('No entries yet.')

    // No entry selected → settings panel must not be in the DOM.
    expect(screen.queryByTestId('content-settings-panel')).toBeNull()
    expect(screen.getByTestId('right-sidebar').getAttribute('data-expanded')).toBe('false')
    expect(
      screen.getByTestId('right-sidebar').style.getPropertyValue('--right-sidebar-panel-width'),
    ).toBe('0px')
    expect(screen.queryByTestId('right-sidebar-panel-slot')).toBeNull()

    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )

    // After creating (and auto-selecting) an entry, the settings panel appears.
    expect(await screen.findByTestId('content-settings-panel')).toBeDefined()
    expect(screen.getByTestId('right-sidebar').getAttribute('data-expanded')).toBe('true')
  })

  it('reopens the selected entry settings panel from the canvas corner after closing it', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    expect(await screen.findByRole('region', { name: 'Posts' })).toBeDefined()
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )

    expect(await screen.findByTestId('content-settings-panel')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /close settings panel/i }))

    expect(screen.queryByTestId('content-settings-panel')).toBeNull()
    const openSettingsButton = screen.getByRole('button', { name: /open settings panel/i })
    expect(openSettingsButton.closest('[data-testid="content-settings-notch"]')).toBeDefined()

    fireEvent.click(openSettingsButton)

    expect(await screen.findByTestId('content-settings-panel')).toBeDefined()
    expect(screen.queryByRole('button', { name: /open settings panel/i })).toBeNull()
  })

  it('does not reopen the settings preference when the last selected entry is cleared', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    const postsRegion = await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(within(postsRegion).getByRole('button', { name: /new post/i }))

    expect(await screen.findByTestId('content-settings-panel')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /close settings panel/i }))
    expect(useWorkspaceLayout.getState().rightPanel.collapsed).toBe(true)

    const entryButton = (await within(postsRegion).findByText('Untitled')).closest('button')
    expect(entryButton).toBeTruthy()
    fireEvent.contextMenu(entryButton as HTMLButtonElement, { clientX: 240, clientY: 320 })
    fireEvent.click(
      within(screen.getByRole('menu', { name: 'Content item options' }))
        .getByRole('menuitem', { name: /^delete$/i }),
    )

    const calls = (globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls ?? []
    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/rows/entry_1' &&
        call.init?.method === 'DELETE'
      )).toBe(true)
    })
    await waitFor(() => {
      expect(within(postsRegion).queryByText('Untitled')).toBeNull()
    })

    expect(screen.queryByTestId('content-settings-panel')).toBeNull()
    expect(screen.getByTestId('right-sidebar').getAttribute('data-expanded')).toBe('false')
    expect(useWorkspaceLayout.getState().rightPanel.collapsed).toBe(true)
  })

  it('shows entry authors in the content list and reassigns the selected entry author', async () => {
    const user = userEvent.setup()
    const calls: FetchCall[] = []
    ;(globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls = calls
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)

      if (url === '/admin/api/cms/data/tables') {
        return json({ tables: [makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')] })
      }

      if (url === '/admin/api/cms/data/authors' && init?.method === 'GET') {
        return json({ authors: [editorAuthor, adminAuthor] })
      }

      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
        return json({
          rows: [makeRow('entry_1', 'posts', {
            title: 'Authored post',
            slug: 'authored-post',
            body: 'Body',
            featuredMedia: null,
            seoTitle: '',
            seoDescription: '',
          }, {
            authorUserId: editorAuthor.id,
            author: editorAuthor,
          })],
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_1/author' && init?.method === 'PATCH') {
        return json({
          row: makeRow('entry_1', 'posts', {
            title: 'Authored post',
            slug: 'authored-post',
            body: 'Body',
            featuredMedia: null,
            seoTitle: '',
            seoDescription: '',
          }, {
            authorUserId: adminAuthor.id,
            author: adminAuthor,
            updatedAt: '2026-05-01T10:04:00.000Z',
          }),
        })
      }

      if (url === '/admin/api/cms/media') {
        return json({ assets: [] })
      }

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    const postsRegion = await screen.findByRole('region', { name: 'Posts' })
    expect(await within(postsRegion).findByText('Editor Name')).toBeDefined()
    expect(await screen.findByTestId('content-settings-panel')).toBeDefined()

    const authorSelect = screen.getByRole('combobox', { name: 'Author' }) as HTMLInputElement
    expect(authorSelect.value).toBe('Editor Name')
    expect(screen.getByText('Editor')).toBeDefined()

    await user.click(authorSelect)
    await user.click(await screen.findByRole('option', { name: 'Admin Name' }))

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/rows/entry_1/author' &&
        call.init?.method === 'PATCH' &&
        call.init?.body === JSON.stringify({ authorUserId: adminAuthor.id })
      )).toBe(true)
    })
    expect((screen.getByRole('combobox', { name: 'Author' }) as HTMLInputElement).value).toBe('Admin Name')
    expect(within(postsRegion).getByText('Admin Name')).toBeDefined()
  })

  it('commits cross-collection tool navigation before an immediate field write', async () => {
    const post = makeRow('post_1', 'posts', {
      title: 'Existing post',
      slug: 'existing-post',
    })
    const article = makeRow('article_2', 'articles', {
      title: 'Requested article',
      slug: 'requested-article',
      seoTitle: '',
    })
    const calls: FetchCall[] = []
    let resolveArticleList: ((response: Response) => void) | null = null
    const articleList = new Promise<Response>((resolve) => {
      resolveArticleList = resolve
    })

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url === '/admin/api/cms/data/tables' && method === 'GET') {
        return json({
          tables: [
            makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts'),
            makeTable('articles', 'Articles', 'articles', '/articles', 'Article', 'Articles'),
          ],
        })
      }
      if (url === '/admin/api/cms/data/tables/posts/rows' && method === 'GET') {
        return json({ rows: [post] })
      }
      if (url === '/admin/api/cms/data/tables/articles/rows' && method === 'GET') {
        return articleList
      }
      if (url === '/admin/api/cms/data/rows/article_2' && method === 'GET') {
        return json({ row: article })
      }
      if (url === '/admin/api/cms/data/rows/article_2' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body))
        return json({
          row: makeRow('article_2', 'articles', body.cells, {
            updatedAt: '2026-07-10T00:01:00.000Z',
          }),
        })
      }
      if (url === '/admin/api/cms/data/authors' && method === 'GET') {
        return json({ authors: [ownerAuthor, editorAuthor, adminAuthor] })
      }
      if (url === '/admin/api/cms/media' && method === 'GET') {
        return json({ assets: [] })
      }

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${method} ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )
    expect(await screen.findByRole('region', { name: 'Posts' })).toBeDefined()
    expect(await screen.findByDisplayValue('Existing post')).toBeDefined()

    let activationResult: Awaited<ReturnType<typeof executeContentTool>> | null = null
    let writeResult: Awaited<ReturnType<typeof executeContentTool>> | null = null
    await act(async () => {
      activationResult = await executeContentTool('content_set_active_document', {
        documentId: 'article_2',
      })
      // No waitFor or render gap: success from activation must make this write
      // see article_2 as the live selected row immediately.
      writeResult = await executeContentTool('content_set_document_field', {
        documentId: 'article_2',
        fieldId: 'seoTitle',
        value: 'Remote SEO',
      })
    })

    expect(activationResult?.ok).toBe(true)
    expect(writeResult?.ok).toBe(true)
    const patchCall = calls.find((call) =>
      String(call.input) === '/admin/api/cms/data/rows/article_2' &&
      call.init?.method === 'PATCH'
    )
    expect(JSON.parse(String(patchCall?.init?.body))).toMatchObject({
      cells: { seoTitle: 'Remote SEO' },
    })

    await waitFor(() => expect(resolveArticleList).not.toBeNull())
    await act(async () => {
      resolveArticleList?.(json({ rows: [article] }))
      await articleList
    })

    const articlesRegion = await screen.findByRole('region', { name: 'Articles' })
    expect(within(articlesRegion).queryByText('Existing post')).toBeNull()
    expect((screen.getByLabelText('SEO title') as HTMLInputElement).value).toBe('Remote SEO')

    // Re-select from the refreshed sidebar. A stale list response must not
    // rehydrate the pre-write row and erase the just-saved field.
    fireEvent.click(within(articlesRegion).getByRole('button', { name: /Requested article/i }))
    expect((screen.getByLabelText('SEO title') as HTMLInputElement).value).toBe('Remote SEO')

    const params = new URLSearchParams(window.location.search)
    expect(params.get('table')).toBe('articles')
    expect(params.get('row')).toBe('article_2')
  })

  it('publishing another document does not steal the active document', async () => {
    // `applyStatus` used to call `updateSelectedEntry` for whatever row it
    // published, active or not. That retargeted the workspace — discarding the
    // author's unsaved draft — and left a tool loop of
    // `set_document_fields → set_document_status` writing one document behind
    // itself, so every field write after the first was refused.
    const postA = makeRow('post_a', 'posts', { title: 'Open post', slug: 'open-post', seoTitle: '' })
    const postB = makeRow('post_b', 'posts', { title: 'Other post', slug: 'other-post', seoTitle: '' })

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (url === '/admin/api/cms/data/tables' && method === 'GET') {
        return json({ tables: [makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')] })
      }
      if (url === '/admin/api/cms/data/tables/posts/rows' && method === 'GET') {
        return json({ rows: [postA, postB] })
      }
      if (url === '/admin/api/cms/data/rows/post_a' && method === 'GET') return json({ row: postA })
      if (url === '/admin/api/cms/data/rows/post_b' && method === 'GET') return json({ row: postB })
      if (url === '/admin/api/cms/data/rows/post_a' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body))
        return json({ row: makeRow('post_a', 'posts', body.cells) })
      }
      if (url === '/admin/api/cms/data/rows/post_b/publish' && method === 'POST') {
        return json({ row: { ...postB, status: 'published', publishedAt: '2026-05-01T10:02:00.000Z' } })
      }
      if (url === '/admin/api/cms/data/authors' && method === 'GET') return json({ authors: [] })
      if (url === '/admin/api/cms/media' && method === 'GET') return json({ assets: [] })

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${method} ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )
    expect(await screen.findByRole('region', { name: 'Posts' })).toBeDefined()

    // Each call gets its own act() so React commits in between and the bridge's
    // workspace ref refreshes. Batching them hides the bug: the ref would still
    // hold the pre-publish workspace and the last write would pass either way.
    let statusResult: Awaited<ReturnType<typeof executeContentTool>> | null = null
    let writeResult: Awaited<ReturnType<typeof executeContentTool>> | null = null
    await act(async () => {
      await executeContentTool('content_set_active_document', { documentId: 'post_a' })
    })
    await act(async () => {
      // Publish the OTHER document…
      statusResult = await executeContentTool('content_set_document_status', {
        documentId: 'post_b',
        status: 'published',
      })
    })
    await act(async () => {
      // …post_a must still be the active document, so this write must land.
      writeResult = await executeContentTool('content_set_document_field', {
        documentId: 'post_a',
        fieldId: 'seoTitle',
        value: 'Still mine',
      })
    })

    expect(statusResult?.ok).toBe(true)
    expect(writeResult?.ok).toBe(true)
    expect(String(writeResult?.error ?? '')).not.toContain('not the active doc')
  })

  it('uses content-specific rail panels instead of editor-only panels', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByTestId('content-explorer-panel')

    const primaryRail = screen.getByTestId('panel-rail-primary')
    const globalRail = screen.getByTestId('panel-rail-global')

    expect(screen.getByTestId('panel-rail-content').getAttribute('aria-label')).toBe('Close Content panel')
    expect(screen.getByTestId('panel-rail-media').getAttribute('aria-label')).toBe('Open Media panel')
    // The AI assistant panel is docked into the content workspace (it is a
    // global rail panel), so its rail button is present + closed.
    expect(screen.getByTestId('panel-rail-agent').getAttribute('aria-label')).toBe('Open AI assistant panel')
    expect(within(primaryRail).queryByTestId('panel-rail-agent')).toBeNull()
    expect(within(globalRail).getByTestId('panel-rail-agent')).toBeDefined()
    expect(screen.getByTestId('content-panel-rail').lastElementChild).toBe(globalRail)
    // Layers + Dependencies remain editor-only and must NOT appear here.
    expect(screen.queryByLabelText('Open Layers panel')).toBeNull()
    expect(screen.queryByLabelText('Open Dependencies panel')).toBeNull()
  })

  it('hides the content AI assistant panel without ai.chat', async () => {
    render(
      <AdminTestProviders user={contentEditorWithoutAiChat()}>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByTestId('content-explorer-panel')

    expect(screen.queryByTestId('panel-rail-agent')).toBeNull()
  })

  it('reuses the shared media explorer panel in the content rail', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByTestId('content-explorer-panel')

    fireEvent.click(screen.getByTestId('panel-rail-media'))

    expect(await screen.findByTestId('media-explorer-panel')).toBeDefined()
    expect(screen.getByLabelText('Search media')).toBeDefined()
    expect(screen.getByRole('button', { name: 'List view' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Grid view' })).toBeDefined()
    expect(screen.queryByTestId('content-media-panel')).toBeNull()
  })

  it('creates, edits, saves, and publishes a rich Markdown-backed post', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    expect(await screen.findByRole('region', { name: 'Posts' })).toBeDefined()
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )

    const title = await screen.findByLabelText('Title')
    fireEvent.change(title, { target: { value: 'My first post' } })

    // The body editor is a single ProseMirror contenteditable surface
    // (one document, not a list of independent block widgets). Assert
    // it mounted and is editable; the editor's rich-input behaviour is
    // covered by the markdown round-trip tests in `markdown.test.ts`.
    const bodyEditor = await screen.findByTestId('content-body-editor')
    expect(bodyEditor.getAttribute('contenteditable')).toBe('true')

    clickToolbarSaveDraft()
    await screen.findByText('Draft saved')

    clickToolbarPublish()
    const publishedButton = await screen.findByRole('button', { name: /^published$/i }) as HTMLButtonElement
    expect(publishedButton.getAttribute('aria-disabled')).toBe('true')

    const calls = (globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls ?? []
    const saveCall = calls.find((call) => String(call.input) === '/admin/api/cms/data/rows/entry_1' && call.init?.method === 'PATCH')
    expect(saveCall?.init?.body).toBe(JSON.stringify({
      cells: {
        title: 'My first post',
        slug: 'untitled',
        body: '',
        featuredMedia: null,
        seoTitle: '',
        seoDescription: '',
      },
    }))
    expect(calls.some((call) =>
      String(call.input) === '/admin/api/cms/data/rows/entry_1/publish' &&
      call.init?.method === 'POST'
    )).toBe(true)
  })

  it('renders the post title as a wrapping multi-line editor', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )

    const title = await screen.findByLabelText('Title') as HTMLTextAreaElement
    const longTitle = "Here's my first long post title that needs to wrap cleanly"

    expect(title.tagName).toBe('TEXTAREA')
    expect(title.getAttribute('rows')).toBe('1')

    fireEvent.change(title, { target: { value: longTitle } })

    expect(title.value).toBe(longTitle)

    const contentCss = readFileSync(join(process.cwd(), 'src/admin/pages/content/ContentPage.module.css'), 'utf8')
    expect(contentCss).toMatch(/\.titleInput\s*\{[^}]*white-space:\s*pre-wrap/s)
    expect(contentCss).toMatch(/\.titleInput\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  })

  it('creates a custom collection and adds entries under that collection label', async () => {
    const calls: FetchCall[] = []
    ;(globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls = calls
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)

      if (url === '/admin/api/cms/data/tables' && init?.method === 'GET') {
        return json({ tables: [makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')] })
      }

      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
        return json({ rows: [] })
      }

      if (url === '/admin/api/cms/data/tables' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        return json({
          table: makeTable('products', body.name ?? 'Products', 'products', '/products', body.singularLabel ?? 'Product', body.pluralLabel ?? 'Products', body.fields),
        }, 201)
      }

      if (url === '/admin/api/cms/data/tables/products/rows' && init?.method === 'GET') {
        return json({ rows: [] })
      }

      if (url === '/admin/api/cms/data/tables/products/rows' && init?.method === 'POST') {
        return json({
          row: makeRow('product_1', 'products', { title: 'Untitled', slug: 'untitled' }),
        }, 201)
      }

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Collections' }))
        .getByRole('button', { name: /new collection/i }),
    )

    const dialog = await screen.findByRole('dialog', { name: /new collection/i })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Product Catalog' } })
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'catalog-items' } })
    fireEvent.change(within(dialog).getByLabelText('URL path'), { target: { value: '/catalog' } })
    fireEvent.change(within(dialog).getByLabelText('Singular label'), { target: { value: 'Product' } })
    fireEvent.change(within(dialog).getByLabelText('Plural label'), { target: { value: 'Catalog' } })
    fireEvent.click(within(dialog).getByLabelText('Featured media'))
    fireEvent.click(within(dialog).getByLabelText('SEO fields'))
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }))

    const catalogRegion = await screen.findByRole('region', { name: 'Catalog' })
    fireEvent.click(within(catalogRegion).getByRole('button', { name: /new product/i }))

    expect(await screen.findByLabelText('Title')).toBeDefined()

    const createCollectionCall = calls.find((call) =>
      String(call.input) === '/admin/api/cms/data/tables' &&
      call.init?.method === 'POST'
    )
    expect(createCollectionCall?.init?.body).toBe(JSON.stringify({
      name: 'Product Catalog',
      slug: 'catalog-items',
      routeBase: '/catalog',
      singularLabel: 'Product',
      pluralLabel: 'Catalog',
      fields: [
        { type: 'text', id: 'title', label: 'Title', required: true, builtIn: true },
        { type: 'text', id: 'slug', label: 'Slug', required: true, builtIn: true },
        { type: 'richText', id: 'body', label: 'Body', format: 'markdown', builtIn: true },
      ],
      kind: 'postType',
    }))
    expect(calls.some((call) =>
      String(call.input) === '/admin/api/cms/data/tables/products/rows' &&
      call.init?.method === 'POST'
    )).toBe(true)
  })

  it('moves the selected entry from the settings sidebar and hides fields disabled by the target collection', async () => {
    const calls: FetchCall[] = []
    ;(globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls = calls
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)

      if (url === '/admin/api/cms/data/tables') {
        return json({
          tables: [
            makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts'),
            makeTable('products', 'Products', 'products', '/products', 'Product', 'Products', titleOnlyFields),
          ],
        })
      }

      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
        return json({
          rows: [makeRow('entry_1', 'posts', {
            title: 'Portable lamp',
            slug: 'portable-lamp',
            body: 'A compact lamp',
            featuredMedia: imageAsset.id,
            seoTitle: 'SEO lamp',
            seoDescription: 'Lamp description',
          }, { updatedAt: '2026-05-01T10:01:00.000Z' })],
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_1/table' && init?.method === 'PATCH') {
        return json({
          row: makeRow('entry_1', 'products', {
            title: 'Portable lamp',
            slug: 'portable-lamp',
            body: 'A compact lamp',
            featuredMedia: imageAsset.id,
            seoTitle: 'SEO lamp',
            seoDescription: 'Lamp description',
          }, { updatedAt: '2026-05-01T10:05:00.000Z' }),
        })
      }

      if (url === '/admin/api/cms/data/tables/products/rows' && init?.method === 'GET') {
        return json({
          rows: [makeRow('entry_1', 'products', {
            title: 'Portable lamp',
            slug: 'portable-lamp',
            body: 'A compact lamp',
            featuredMedia: imageAsset.id,
            seoTitle: 'SEO lamp',
            seoDescription: 'Lamp description',
          }, { updatedAt: '2026-05-01T10:05:00.000Z' })],
        })
      }

      if (url === '/admin/api/cms/media') {
        return json({ assets: [imageAsset] })
      }

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    expect(await screen.findByDisplayValue('Portable lamp')).toBeDefined()
    expect(screen.getByLabelText('SEO title')).toBeDefined()
    expect(screen.getByText('Featured media')).toBeDefined()

    fireEvent.click(screen.getByLabelText('Collection'))
    fireEvent.click(await screen.findByRole('option', { name: 'Products' }))

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/rows/entry_1/table' &&
        call.init?.method === 'PATCH' &&
        call.init?.body === JSON.stringify({ tableId: 'products' })
      )).toBe(true)
    })

    expect(await screen.findByRole('region', { name: 'Products' })).toBeDefined()
    expect(screen.queryByLabelText('SEO title')).toBeNull()
    expect(screen.queryByText('Featured media')).toBeNull()
  })

  it('opens explorer-style context menus for content collections and entries', async () => {
    const calls: FetchCall[] = []
    ;(globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls = calls
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)

      if (url === '/admin/api/cms/data/tables' && init?.method === 'GET') {
        return json({
          tables: [
            makeTable('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts'),
            makeTable('products', 'Products', 'products', '/products', 'Product', 'Products'),
          ],
        })
      }

      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
        return json({
          rows: [
            makeRow('entry_1', 'posts', { title: 'Summer sale', slug: 'summer-sale', body: 'Sale copy', featuredMedia: null, seoTitle: '', seoDescription: '' }, { updatedAt: '2026-05-01T10:01:00.000Z' }),
            makeRow('entry_2', 'posts', { title: 'Published story', slug: 'published-story', body: 'Published copy', featuredMedia: null, seoTitle: '', seoDescription: '' }, { status: 'published', updatedAt: '2026-05-01T10:02:00.000Z', publishedAt: '2026-05-01T10:02:00.000Z' }),
          ],
        })
      }

      if (url === '/admin/api/cms/data/tables/products/rows' && init?.method === 'GET') {
        return json({ rows: [] })
      }

      if (url === '/admin/api/cms/data/rows/entry_1' && init?.method === 'PATCH') {
        const draft = JSON.parse(String(init.body))
        return json({
          row: {
            ...makeRow('entry_1', 'posts', draft.cells ?? {}),
            updatedAt: '2026-05-01T10:05:00.000Z',
          },
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_1/publish' && init?.method === 'POST') {
        return json({
          row: makeRow('entry_1', 'posts', { title: 'Summer sale', slug: 'summer-sale', body: 'Sale copy', featuredMedia: null, seoTitle: '', seoDescription: '' }, { status: 'published', updatedAt: '2026-05-01T10:03:00.000Z', publishedAt: '2026-05-01T10:03:00.000Z' }),
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_2/status' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        return json({
          row: makeRow('entry_2', 'posts', { title: 'Published story', slug: 'published-story', body: 'Published copy', featuredMedia: null, seoTitle: '', seoDescription: '' }, { status: body.status, updatedAt: '2026-05-01T10:04:00.000Z' }),
        })
      }

      if (url === '/admin/api/cms/data/rows/entry_1' && init?.method === 'DELETE') {
        return json({
          row: makeRow('entry_1', 'posts', { title: 'Winter sale', slug: 'winter-sale', body: 'Sale copy', featuredMedia: null, seoTitle: '', seoDescription: '' }, { updatedAt: '2026-05-01T10:06:00.000Z', deletedAt: '2026-05-01T10:06:00.000Z' }),
        })
      }

      if (url === '/admin/api/cms/data/tables/products' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        return json({
          table: {
            ...makeTable('products', 'Products', 'products', '/products', 'Product', 'Products'),
            ...body,
            updatedAt: '2026-05-01T10:07:00.000Z',
          },
        })
      }

      if (url === '/admin/api/cms/data/tables/products' && init?.method === 'DELETE') {
        return json({
          table: makeTable('products', 'Catalog', 'catalog', '/catalog', 'Product', 'Catalog'),
        })
      }

      if (url === '/admin/api/cms/media') {
        return json({ assets: [] })
      }

      const ambient = ambientFetchFallback(url)
      if (ambient) return ambient
      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    const postsRegion = await screen.findByRole('region', { name: 'Posts' })
    const publishedButton = (await within(postsRegion).findByText('Published story')).closest('button')
    expect(publishedButton).toBeTruthy()

    fireEvent.contextMenu(publishedButton as HTMLButtonElement, { clientX: 240, clientY: 300 })
    let menu = screen.getByRole('menu', { name: 'Content item options' })
    expect(within(menu).getByRole('menuitem', { name: /open in new tab/i })).toBeDefined()
    expect(within(menu).getByRole('menuitem', { name: /convert to draft/i })).toBeDefined()
    expect(within(menu).queryByRole('menuitem', { name: /^publish$/i })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /convert to draft/i }))
    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/rows/entry_2/status' &&
        call.init?.method === 'PATCH' &&
        call.init?.body === JSON.stringify({ status: 'draft' })
      )).toBe(true)
    })

    const entryButton = (await within(postsRegion).findByText('Summer sale')).closest('button')
    expect(entryButton).toBeTruthy()

    fireEvent.contextMenu(entryButton as HTMLButtonElement, { clientX: 240, clientY: 320 })
    menu = screen.getByRole('menu', { name: 'Content item options' })
    expect(within(menu).getByRole('menuitem', { name: /^publish$/i })).toBeDefined()
    expect(within(menu).queryByRole('menuitem', { name: /convert to draft/i })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: /open in new tab/i })).toBeNull()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^publish$/i }))
    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/rows/entry_1/publish' &&
        call.init?.method === 'POST'
      )).toBe(true)
    })

    fireEvent.contextMenu(entryButton as HTMLButtonElement, { clientX: 240, clientY: 320 })
    menu = screen.getByRole('menu', { name: 'Content item options' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^rename$/i }))

    let dialog = await screen.findByRole('dialog', { name: /rename post/i })
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Winter sale' } })
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'winter-sale' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))

    expect(await within(postsRegion).findByText('Winter sale')).toBeDefined()
    expect(calls.some((call) =>
      String(call.input) === '/admin/api/cms/data/rows/entry_1' &&
      call.init?.method === 'PATCH' &&
      call.init?.body === JSON.stringify({
        cells: {
          title: 'Winter sale',
          slug: 'winter-sale',
          body: 'Sale copy',
          featuredMedia: null,
          seoTitle: '',
          seoDescription: '',
        },
      })
    )).toBe(true)

    const collectionsRegion = screen.getByRole('region', { name: 'Collections' })
    const productsButton = within(collectionsRegion)
      .getByText('Products')
      .closest('button')
    expect(productsButton).toBeTruthy()

    fireEvent.contextMenu(productsButton as HTMLButtonElement, { clientX: 220, clientY: 210 })
    menu = screen.getByRole('menu', { name: 'Content item options' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /collection settings/i }))

    dialog = await screen.findByRole('dialog', { name: /collection settings/i })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Catalog' } })
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'catalog' } })
    fireEvent.change(within(dialog).getByLabelText('URL path'), { target: { value: '/catalog' } })
    fireEvent.change(within(dialog).getByLabelText('Plural label'), { target: { value: 'Catalog' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }))

    expect(await within(collectionsRegion).findByText('Catalog')).toBeDefined()
    expect(calls.some((call) =>
      String(call.input) === '/admin/api/cms/data/tables/products' &&
      call.init?.method === 'PATCH' &&
      call.init?.body === JSON.stringify({
        name: 'Catalog',
        slug: 'catalog',
        routeBase: '/catalog',
        singularLabel: 'Product',
        pluralLabel: 'Catalog',
        fields: allBuiltInFields,
      })
    )).toBe(true)

    const renamedEntryButton = within(screen.getByRole('region', { name: 'Posts' }))
      .getByRole('button', { name: /winter sale draft/i })
    fireEvent.contextMenu(renamedEntryButton as HTMLButtonElement, { clientX: 240, clientY: 320 })
    menu = screen.getByRole('menu', { name: 'Content item options' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^delete$/i }))

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/rows/entry_1' &&
        call.init?.method === 'DELETE'
      )).toBe(true)
    })
    expect(within(screen.getByRole('region', { name: 'Posts' })).queryByText('Winter sale')).toBeNull()

    const catalogButton = within(screen.getByRole('region', { name: 'Collections' }))
      .getByText('Catalog')
      .closest('button')
    fireEvent.contextMenu(catalogButton as HTMLButtonElement, { clientX: 220, clientY: 210 })
    menu = screen.getByRole('menu', { name: 'Content item options' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^delete$/i }))

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/data/tables/products' &&
        call.init?.method === 'DELETE'
      )).toBe(true)
    })
    expect(within(screen.getByRole('region', { name: 'Collections' })).queryByText('Catalog')).toBeNull()
  })

  it('opens the selected post in a new browser tab from the content toolbar', async () => {
    const originalOpen = window.open
    const openCalls: unknown[] = []
    window.open = ((...args: unknown[]) => {
      openCalls.push(args)
      return null
    }) as typeof window.open

    try {
      render(
        <AdminTestProviders>
          <ContentPage />
        </AdminTestProviders>,
      )

      await screen.findByRole('region', { name: 'Posts' })
      fireEvent.click(
        within(screen.getByRole('region', { name: 'Posts' }))
          .getByRole('button', { name: /new post/i }),
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /more publishing actions/i }).hasAttribute('disabled')).toBe(false)
      })
      fireEvent.click(screen.getByRole('button', { name: /more publishing actions/i }))
      const menu = screen.getByRole('menu', { name: /publishing actions/i })
      fireEvent.click(within(menu).getByRole('menuitem', { name: /open live post/i }))

      expect(openCalls).toEqual([['/posts/untitled', '_blank', 'noopener,noreferrer']])
    } finally {
      window.open = originalOpen
    }
  })

  it('exposes the slash menu and notch insertion affordances on the body editor', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )

    // The Tiptap surface mounts as a single contenteditable region.
    await screen.findByTestId('content-body-editor')

    // Notch actions for inserting headings, paragraphs, media, and data
    // tokens — the editor doesn't carry a per-block type chevron menu,
    // because the document is one ProseMirror tree, not a stack of
    // independent block widgets.
    expect(screen.getByRole('button', { name: /add heading/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /add text/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /add media/i })).toBeDefined()
    expect(screen.getByRole('button', { name: /add insert data token/i })).toBeDefined()
  })

  it('inserts a media node into the body via the notch and persists it as markdown', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )

    await screen.findByTestId('content-body-editor')

    // The notch "Media" button opens the workspace media picker. Pick an
    // image, commit, and confirm the editor surfaces a media node and the
    // saved draft body cell holds the markdown image line.
    fireEvent.click(screen.getByRole('button', { name: /add media/i }))
    fireEvent.click(await screen.findByRole('button', { name: /hero\.png/i }))
    fireEvent.click(screen.getByRole('button', { name: /use selected/i }))

    expect(await screen.findByRole('img', { name: 'hero.png' })).toBeDefined()

    clickToolbarSaveDraft()
    await screen.findByText('Draft saved')

    const calls = (globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls ?? []
    const saveCalls = calls.filter((call) => String(call.input) === '/admin/api/cms/data/rows/entry_1' && call.init?.method === 'PATCH')
    expect(saveCalls.at(-1)?.init?.body).toBe(JSON.stringify({
      cells: {
        title: 'Untitled',
        slug: 'untitled',
        body: '![hero.png](/uploads/hero.png)',
        featuredMedia: null,
        seoTitle: '',
        seoDescription: '',
      },
    }))
  })

  // Drag-and-drop block reorder was a Gutenberg-style affordance on the old
  // block-list editor. The new editor is a single ProseMirror document; reorder
  // is done at the text level (cut/paste, keyboard move). See the design plan
  // at `docs/superpowers/plans/2026-05-26-content-editor-tiptap.md` for why
  // this is intentional.

  it('edits slug, status, and featured media from the settings sidebar', async () => {
    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    await screen.findByRole('region', { name: 'Posts' })
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Posts' }))
        .getByRole('button', { name: /new post/i }),
    )
    const title = await screen.findByLabelText('Title')
    fireEvent.change(title, { target: { value: 'My first post' } })
    clickToolbarPublish()
    const publishedButton = await screen.findByRole('button', { name: /^published$/i }) as HTMLButtonElement
    expect(publishedButton.getAttribute('aria-disabled')).toBe('true')

    const slugInput = screen.getByLabelText('Slug') as HTMLInputElement
    expect(slugInput.disabled).toBe(false)
    fireEvent.change(slugInput, { target: { value: 'updated slug' } })

    fireEvent.click(screen.getByRole('button', { name: /choose featured media/i }))
    // Workspace-style MediaPickerModal: pick + commit via "Use selected".
    fireEvent.click(await screen.findByRole('button', { name: /hero\.png/i }))
    fireEvent.click(screen.getByRole('button', { name: /use selected/i }))

    clickToolbarSaveDraft()
    await screen.findByText('Draft saved')

    fireEvent.change(screen.getByLabelText('Status'), {
      target: { value: 'unpublished' },
    })
    await screen.findByText('Unpublished')

    const calls = (globalThis as typeof globalThis & { __contentFetchCalls?: FetchCall[] }).__contentFetchCalls ?? []
    const saveCalls = calls.filter((call) => String(call.input) === '/admin/api/cms/data/rows/entry_1' && call.init?.method === 'PATCH')
    expect(saveCalls.at(-1)?.init?.body).toBe(JSON.stringify({
      cells: {
        title: 'My first post',
        slug: 'updated-slug',
        body: '',
        featuredMedia: imageAsset.id,
        seoTitle: '',
        seoDescription: '',
      },
    }))
    expect(calls.some((call) =>
      String(call.input) === '/admin/api/cms/data/rows/entry_1/status' &&
      call.init?.method === 'PATCH' &&
      call.init?.body === JSON.stringify({ status: 'unpublished' })
    )).toBe(true)
  })

  it('hydrates saved featured media metadata when reopening the content page', async () => {
    const baseFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/data/tables/posts/rows' && init?.method === 'GET') {
        return json({
          rows: [makeRow('entry_1', 'posts', {
            title: 'First post',
            slug: 'first-post',
            body: '',
            featuredMedia: imageAsset.id,
            seoTitle: '',
            seoDescription: '',
          }, {
            status: 'published',
            updatedAt: '2026-05-01T10:01:00.000Z',
            publishedAt: '2026-05-01T10:01:00.000Z',
          })],
        })
      }

      return baseFetch(input, init)
    }

    render(
      <AdminTestProviders>
        <ContentPage />
      </AdminTestProviders>,
    )

    // The shared MediaPickerField tile renders filename + a metadata line
    // (mime · size · dimensions) instead of the saved publicPath — same
    // shape used by the property panel's media controls.
    expect(await screen.findByText(imageAsset.filename)).toBeDefined()
    expect(screen.getByText(new RegExp(imageAsset.mimeType.replace('/', '\\/')))).toBeDefined()
    expect(screen.queryByText(imageAsset.id)).toBeNull()
  })

  // Per-block contenteditable keystroke and Enter-splits-into-new-block tests
  // belonged to the old block-list editor. The new editor is a single
  // ProseMirror surface — keystroke handling is ProseMirror's job, covered
  // upstream. Round-trip markdown coverage lives in `markdown.test.ts`.

  it('uses Tiptap for the body editor and serialises to markdown on update', () => {
    const src = readFileSync(join(process.cwd(), 'src/admin/pages/content/TiptapBodyEditor.tsx'), 'utf8')

    expect(src).toContain('useEditor')
    expect(src).toContain('proseMirrorDocToMarkdown')
    expect(src).toContain('markdownToProseMirrorDoc')
    // The bubble menu and slash menu are the inline-mark and block-insert
    // affordances; both must be wired up for the editor's interaction
    // model to match the proposal.
    expect(src).toContain('BodyBubbleMenu')
    expect(src).toContain('BodySlashMenu')
  })

  it('uses the shared context-menu primitive for slash commands', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/admin/pages/content/components/BodySlashMenu/BodySlashMenu.tsx'),
      'utf8',
    )

    expect(src).toContain("from '@ui/components/ContextMenu'")
    expect(src).toContain('<ContextMenu')
    expect(src).toContain('<ContextMenuItem')
    expect(src).not.toContain('createPortal')
    expect(src).not.toContain('BodySlashMenu.module.css')
  })

  it('uses the shared data-binding picker instead of inserting a fixed token', () => {
    const src = readFileSync(join(process.cwd(), 'src/admin/pages/content/ContentPage.tsx'), 'utf8')

    expect(src).toContain("from '@admin/shared/DataBindingPicker'")
    expect(src).toContain('<DataBindingPicker')
    expect(src).toContain('bindingToToken(binding.source, binding.field)')
    expect(src).not.toContain("insertText('{currentEntry.title}')")
  })

  it('uses the content publish button as the single published-state indicator', () => {
    const src = readFileSync(join(process.cwd(), 'src/admin/pages/content/components/ContentToolbar/ContentToolbar.tsx'), 'utf8')

    expect(src).toContain("'Retry publish'")
    expect(src).toContain("'Published'")
    expect(src).toContain('statusLabel={isCleanPublished ? null : statusText}')
    expect(src).toContain('publishDisabled={!selectedEntry || !canPublish || isPublishing || isCleanPublished}')
    expect(src).not.toContain("'Live'")
    expect(src).toContain('isCleanPublished ? CheckIcon')
    expect(src).not.toContain("'Publish failed'")
  })
})
