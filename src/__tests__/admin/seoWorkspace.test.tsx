/**
 * SEO workspace UI tests — /admin/tools/seo.
 *
 * Renders the Meta/Robots/Sitemap tabs against a mocked fetch:
 *   - tab switching through the Tabs primitive
 *   - target search / filter / selection driving the preview editor
 *   - snippet edits writing the STRUCTURED seo object on save
 *   - inherited values rendering as placeholders (X falls back to OG/search)
 *   - the Customize X gate
 *   - robots toggles updating the generated preview
 *   - the Tools nav dropdown exposing the SEO link
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from '@admin/lib/routing'
import { AdminSessionProvider } from '@admin/session'
import { StepUpProvider } from '@admin/shared/StepUp'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import { MetaTab } from '@admin/pages/seo/tabs/MetaTab'
import { RobotsTab } from '@admin/pages/seo/tabs/RobotsTab'
import { SitemapTab } from '@admin/pages/seo/tabs/SitemapTab'
import { SeoToolbar } from '@admin/pages/seo/components/SeoToolbar'
import { useSeoWorkspace } from '@admin/pages/seo/hooks/useSeoWorkspace'
import { useSeoSaveBridge } from '@admin/pages/seo/hooks/useSeoSaveBridge'
import type { CmsCurrentUser } from '@core/persistence'

const originalFetch = globalThis.fetch
const now = '2026-06-12T10:00:00.000Z'

function currentUser(capabilities: string[]): CmsCurrentUser {
  return {
    id: 'user_1',
    email: 'seo@example.com',
    displayName: 'SEO Editor',
    status: 'active',
    role: {
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

interface FetchCall {
  input: RequestInfo | URL
  init?: RequestInit
}

const TARGETS_PAYLOAD = {
  siteName: 'Acme',
  language: 'en',
  publicOrigin: 'https://acme.com',
  faviconUrl: null,
  siteSeo: {
    titlePattern: '{page.title} — {site.name}',
    description: 'Site default description',
  },
  targets: [
    {
      kind: 'page',
      id: 'page_home',
      title: 'Home',
      route: '/',
      seo: null,
      status: 'published',
      updatedAt: now,
      publishedAt: now,
    },
    {
      kind: 'page',
      id: 'page_about',
      title: 'About',
      route: '/about',
      seo: { title: 'About Acme', description: 'Who we are.' },
      status: 'published',
      updatedAt: now,
      publishedAt: now,
    },
    {
      kind: 'template',
      id: 'page_tpl',
      title: 'Post template',
      route: null,
      templateTableSlugs: ['posts'],
      seo: { title: '{currentEntry.title} — {site.name}' },
      status: 'published',
      updatedAt: now,
      publishedAt: null,
    },
    {
      kind: 'post',
      id: 'row_hello',
      title: 'Hello world',
      route: '/posts/hello-world',
      tableSlug: 'posts',
      tableLabel: 'Posts',
      seo: null,
      status: 'published',
      updatedAt: now,
      publishedAt: now,
    },
  ],
}

function mockSeoFetch(): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    const url = String(input)
    if (url === '/admin/api/cms/seo/targets') return json(TARGETS_PAYLOAD)
    if (url.startsWith('/admin/api/cms/seo/targets/') && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { seo: Record<string, unknown> }
      const id = url.split('/').at(-1)
      const stored = TARGETS_PAYLOAD.targets.find((t) => t.id === id)!
      return json({ target: { ...stored, seo: body.seo } })
    }
    if (url.match(/^\/admin\/api\/cms\/data\/rows\/[^/]+\/publish$/) && init?.method === 'POST') {
      const id = url.split('/').at(-2)!
      // RowEnvelope validates a full DataRow shape — return one.
      return json({
        row: {
          id,
          tableId: 'posts',
          cells: { title: 'Hello world', slug: 'hello-world' },
          slug: 'hello-world',
          status: 'published',
          authorUserId: null,
          createdByUserId: null,
          updatedByUserId: null,
          publishedByUserId: null,
          author: null,
          createdBy: null,
          updatedBy: null,
          publishedBy: null,
          createdAt: now,
          updatedAt: now,
          publishedAt: now,
          scheduledPublishAt: null,
          deletedAt: null,
        },
      })
    }
    if (url === '/admin/api/cms/media') {
      // SeoImageField resolves picked-tile thumbnails from the asset list.
      return json({ assets: [] })
    }
    if (url === '/admin/api/cms/seo/site' && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { seo: Record<string, unknown> }
      return json({ seo: body.seo })
    }
    return json({ error: `Unhandled ${url}` }, 404)
  }) as typeof fetch
  return calls
}

/**
 * Mirrors SeoPage's wiring: the tab registers on the save bridge and the
 * toolbar's PublishActionGroup drives it — without the AdminPageLayout
 * chrome the page itself adds.
 */
function MetaHarness({ canManage = true }: { canManage?: boolean }) {
  const workspace = useSeoWorkspace()
  const bridge = useSeoSaveBridge()
  if (workspace.loading) return <p>Loading…</p>
  return (
    <>
      <SeoToolbar status={bridge.status} onSave={bridge.save} onPublish={bridge.publish} />
      <MetaTab workspace={workspace} canManage={canManage} bridge={bridge} />
    </>
  )
}

function RobotsHarness() {
  const workspace = useSeoWorkspace()
  const bridge = useSeoSaveBridge()
  if (workspace.loading) return <p>Loading…</p>
  return <RobotsTab workspace={workspace} canManage bridge={bridge} />
}

function SitemapHarness() {
  const workspace = useSeoWorkspace()
  const bridge = useSeoSaveBridge()
  if (workspace.loading) return <p>Loading…</p>
  return <SitemapTab workspace={workspace} canManage bridge={bridge} />
}

function renderWithSession(node: React.ReactElement, capabilities: string[] = ['seo.read', 'seo.manage', 'ai.chat', 'pages.publish', 'content.publish.any']) {
  return render(
    <MemoryRouter initialEntries={['/admin/tools/seo']}>
      <AdminSessionProvider user={currentUser(capabilities)}>
        {/* The real app provides StepUpProvider in AuthenticatedAdmin — the
            SEO editors consume useStepUp for the publish action. */}
        <StepUpProvider>
          {node}
        </StepUpProvider>
      </AdminSessionProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('SEO Meta tab', () => {
  it('lists targets, filters by search, and selects into the editor', async () => {
    mockSeoFetch()
    renderWithSession(<MetaHarness />)

    const aboutRow = await screen.findByTestId('seo-target-page_about')
    expect(screen.getByTestId('seo-target-site-defaults')).toBeDefined()
    expect(screen.getByTestId('seo-target-row_hello')).toBeDefined()

    // Search narrows the list.
    fireEvent.change(screen.getByTestId('seo-target-search'), { target: { value: 'about' } })
    expect(screen.queryByTestId('seo-target-row_hello')).toBeNull()

    // Selecting a row activates the preview editor for that target.
    fireEvent.click(aboutRow)
    const editor = await screen.findByRole('region', { name: 'SEO for About' })
    expect(within(editor).getByDisplayValue('About Acme')).toBeDefined()
  })

  it('shows inherited values as placeholders and saves the structured object', async () => {
    const calls = mockSeoFetch()
    renderWithSession(<MetaHarness />)

    fireEvent.click(await screen.findByTestId('seo-target-page_home'))
    const editor = await screen.findByRole('region', { name: 'SEO for Home' })

    // No explicit title — the placeholder shows the interpolated site pattern.
    const titleInput = within(editor).getByLabelText('Title') as HTMLInputElement
    expect(titleInput.value).toBe('')
    expect(titleInput.placeholder).toBe('Home — Acme')

    fireEvent.change(titleInput, { target: { value: 'Welcome to Acme' } })
    fireEvent.change(within(editor).getByLabelText('Description'), {
      target: { value: 'The Acme homepage.' },
    })
    // Save draft lives in the toolbar's publish-actions menu, like Content.
    fireEvent.click(screen.getByTestId('toolbar-publish-actions-trigger'))
    fireEvent.click(screen.getByTestId('toolbar-seo-save-draft'))

    await waitFor(() => {
      const put = calls.find(
        (call) =>
          String(call.input) === '/admin/api/cms/seo/targets/page/page_home' &&
          call.init?.method === 'PUT',
      )
      expect(put).toBeDefined()
      expect(JSON.parse(String(put!.init!.body))).toEqual({
        seo: { title: 'Welcome to Acme', description: 'The Acme homepage.' },
      })
    })
  })

  it('keeps X fields behind the customize gate until they differ', async () => {
    mockSeoFetch()
    renderWithSession(<MetaHarness />)

    fireEvent.click(await screen.findByTestId('seo-target-page_about'))
    const editor = await screen.findByRole('region', { name: 'SEO for About' })

    // The X section starts collapsed behind the customize gate.
    expect(within(editor).queryByLabelText('X title')).toBeNull()

    fireEvent.click(screen.getByTestId('seo-customize-x'))
    const xTitle = within(editor).getByLabelText('X title') as HTMLInputElement
    // Inherits the search title through the OG fallback chain.
    expect(xTitle.placeholder).toBe('About Acme')
  })

  it('saves then publishes a post through the row publish endpoint', async () => {
    const calls = mockSeoFetch()
    renderWithSession(<MetaHarness />)

    fireEvent.click(await screen.findByTestId('seo-target-row_hello'))
    const editor = await screen.findByRole('region', { name: 'SEO for Hello world' })
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Published title' } })

    fireEvent.click(screen.getByTestId('toolbar-publish-btn'))
    await screen.findByText('Published — live')

    const put = calls.find(
      (call) => String(call.input) === '/admin/api/cms/seo/targets/post/row_hello' && call.init?.method === 'PUT',
    )
    expect(put).toBeDefined()
    const publish = calls.find(
      (call) => String(call.input) === '/admin/api/cms/data/rows/row_hello/publish' && call.init?.method === 'POST',
    )
    expect(publish).toBeDefined()
  })

  it('renders the sidebar score summary and jumps the index to the issues filter', async () => {
    mockSeoFetch()
    renderWithSession(<MetaHarness />)

    // Site-wide score ring + live per-target score chip in the editor.
    await screen.findByLabelText(/Site SEO score: \d+ out of 100/)
    expect(screen.getByTestId('seo-score-chip')).toBeDefined()

    // Every seeded target has at least one open check, so the issues line
    // is present; clicking it narrows the index to issue targets only.
    fireEvent.click(screen.getByTestId('seo-issues-line'))
    expect(screen.queryByTestId('seo-issues-line')).toBeNull()
    expect(screen.getByTestId('seo-target-page_home')).toBeDefined()
  })

  it('clicking an improvement focuses the field it describes', async () => {
    mockSeoFetch()
    renderWithSession(<MetaHarness />)

    fireEvent.click(await screen.findByTestId('seo-target-page_about'))
    const editor = await screen.findByRole('region', { name: 'SEO for About' })

    // "About Acme" has no social image — the improvement row points at the
    // OG image field (a tabIndex=-1 container, since the Library mode has no
    // single input to land on).
    fireEvent.click(within(editor).getByTestId('seo-improvement-socialImage'))
    expect((document.activeElement as HTMLElement).id.endsWith('-ogImage')).toBe(true)
  })

  it('guards target switching while the editor is dirty', async () => {
    mockSeoFetch()
    renderWithSession(<MetaHarness />)

    fireEvent.click(await screen.findByTestId('seo-target-page_home'))
    const editor = await screen.findByRole('region', { name: 'SEO for Home' })
    fireEvent.change(within(editor).getByLabelText('Title'), { target: { value: 'Dirty' } })

    // Switching opens the in-app confirm dialog instead of discarding.
    fireEvent.click(screen.getByTestId('seo-target-page_about'))
    expect(await screen.findByText('Discard unsaved changes?')).toBeDefined()

    fireEvent.click(screen.getByTestId('seo-discard-switch'))
    expect(await screen.findByRole('region', { name: 'SEO for About' })).toBeDefined()
  })
})

describe('SEO Robots tab', () => {
  it('renders the editable robots.txt seeded with the default template', async () => {
    mockSeoFetch()
    renderWithSession(<RobotsHarness />)

    // The container mirrors the live content in data-content (the lazy CM6
    // editor paints only measured-visible lines in a test DOM).
    const editor = await screen.findByTestId('seo-robots-editor')
    expect(editor.getAttribute('data-content')).toContain('User-agent: *')
    expect(editor.getAttribute('data-content')).toContain('Disallow: /admin')
  })

  it('a quick-insert shortcut edits the document', async () => {
    mockSeoFetch()
    renderWithSession(<RobotsHarness />)
    await screen.findByTestId('seo-robots-editor')

    fireEvent.click(screen.getByTestId('seo-robots-block-ai'))
    const content = screen.getByTestId('seo-robots-editor').getAttribute('data-content') ?? ''
    expect(content).toContain('User-agent: GPTBot')
    expect(content).toContain('User-agent: PerplexityBot')
  })

  it('surfaces an AI-crawler recommendation and applies it on click', async () => {
    mockSeoFetch()
    renderWithSession(<RobotsHarness />)
    await screen.findByTestId('seo-robots-editor')

    // Default template leaves AI crawlers allowed → the recommendation shows.
    const rec = await screen.findByTestId('seo-robots-rec-ai-training')
    fireEvent.click(rec)

    expect(screen.getByTestId('seo-robots-editor').getAttribute('data-content')).toContain('User-agent: GPTBot')
    // Applied → recommendation gone.
    expect(screen.queryByTestId('seo-robots-rec-ai-training')).toBeNull()
  })

  it('URL tester reports a blocked system path and an allowed content path', async () => {
    mockSeoFetch()
    renderWithSession(<RobotsHarness />)
    await screen.findByTestId('seo-robots-editor')

    fireEvent.change(screen.getByTestId('seo-robots-test-ua'), { target: { value: 'Googlebot' } })
    fireEvent.change(screen.getByTestId('seo-robots-test-path'), { target: { value: '/admin/users' } })
    expect(screen.getByTestId('seo-robots-test-result').textContent).toContain('Blocked')

    fireEvent.change(screen.getByTestId('seo-robots-test-path'), { target: { value: '/about' } })
    expect(screen.getByTestId('seo-robots-test-result').textContent).toContain('Allowed')
  })
})

describe('SEO Sitemap tab', () => {
  it('lists routable targets with include switches and a count', async () => {
    mockSeoFetch()
    renderWithSession(<SitemapHarness />)

    // Routable targets: Home (/), About (/about), Hello world (/posts/…).
    // The template has no route and is excluded.
    expect(await screen.findByText('Hello world')).toBeDefined()
    expect(screen.getByTestId('seo-sitemap-counts').textContent).toContain('3 of 3')
    expect(screen.queryByText('Post template')).toBeNull()
  })

  it('turning generation off replaces the list with the disabled state', async () => {
    mockSeoFetch()
    renderWithSession(<SitemapHarness />)
    await screen.findByText('Hello world')

    fireEvent.click(screen.getByTestId('seo-sitemap-enabled'))
    expect(screen.queryByText('Hello world')).toBeNull()
    expect(screen.getByTestId('seo-sitemap-counts').textContent).toContain('off')
  })
})

describe('Tools navigation', () => {
  it('exposes the SEO link inside the Tools dropdown', async () => {
    mockSeoFetch()
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <AdminSessionProvider user={currentUser(['dashboard.read', 'seo.read'])}>
          <AdminSectionNavigation section="dashboard" />
        </AdminSessionProvider>
      </MemoryRouter>,
    )

    fireEvent.click(await screen.findByTestId('tools-nav-trigger'))
    expect(await screen.findByTestId('tools-nav-seo')).toBeDefined()
  })

  it('opens the Tools dropdown on hover', async () => {
    mockSeoFetch()
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <AdminSessionProvider user={currentUser(['dashboard.read', 'seo.read'])}>
          <AdminSectionNavigation section="dashboard" />
        </AdminSessionProvider>
      </MemoryRouter>,
    )

    fireEvent.mouseEnter(await screen.findByTestId('tools-nav-trigger'))
    expect(await screen.findByTestId('tools-nav-seo')).toBeDefined()
  })

  it('hides the Tools dropdown without seo.read or plugin pages', () => {
    mockSeoFetch()
    render(
      <MemoryRouter initialEntries={['/admin/dashboard']}>
        <AdminSessionProvider user={currentUser(['dashboard.read'])}>
          <AdminSectionNavigation section="dashboard" />
        </AdminSessionProvider>
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('tools-nav-trigger')).toBeNull()
  })
})
