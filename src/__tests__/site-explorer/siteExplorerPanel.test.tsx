import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'fs'
import { SiteExplorerPanel } from '@site/panels/SiteExplorerPanel'
import { MediaExplorerPanel } from '@site/panels/MediaExplorerPanel'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import type { VisualComponent } from '@core/visualComponents'
import '@modules/base/index'

afterEach(cleanup)

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    codeEditorPanelOpen: false,
    activeEditorFileId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function makeVisualComponent(name: string): VisualComponent {
  const rootId = `root-${name}`
  return {
    id: `vc-${name}`,
    name,
    tree: {
      rootNodeId: rootId,
      nodes: {
        [rootId]: {
          id: rootId,
          moduleId: 'base.body',
          props: {},
          children: [],
          breakpointOverrides: {},
          classIds: [],
        },
      },
    },
    params: [],
    breakpoints: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
  }
}

function loadSite() {
  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: {
      'root-home': makeNode({ id: 'root-home', moduleId: 'base.body' }),
    },
  })
  const pricing = makePage({
    id: 'page-pricing',
    title: 'Pricing',
    slug: 'pricing',
    rootNodeId: 'root-pricing',
    nodes: {
      'root-pricing': makeNode({ id: 'root-pricing', moduleId: 'base.body' }),
    },
  })

  useEditorStore.setState({
    site: makeSite({
      pages: [home, pricing],
      visualComponents: [makeVisualComponent('HeroCard')],
      files: [
        {
          id: 'style-1',
          path: 'src/styles/theme.css',
          type: 'style',
          content: ':root { color-scheme: light; }',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'script-1',
          path: 'src/scripts/analytics.ts',
          type: 'script',
          content: 'export {}',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'asset-1',
          path: 'public/logo.svg',
          type: 'asset',
          blob: { mimeType: 'image/svg+xml', base64: 'PHN2Zy8+' },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'asset-video-1',
          path: 'public/intro.mp4',
          type: 'asset',
          blob: { mimeType: 'video/mp4', base64: 'AAAA' },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'asset-other-1',
          path: 'public/catalog.pdf',
          type: 'asset',
          blob: { mimeType: 'application/pdf', base64: 'AAAA' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }),
    activePageId: 'page-home',
  } as Parameters<typeof useEditorStore.setState>[0])
}

function rowForButton(buttonName: RegExp): HTMLElement {
  const row = screen.getByRole('button', { name: buttonName }).closest('[role="treeitem"]')
  if (!(row instanceof HTMLElement)) throw new Error(`Expected tree row for ${buttonName}`)
  return row
}

beforeEach(resetStore)

describe('SiteExplorerPanel', () => {
  it('uses the shared site creation dialog instead of native prompts', () => {
    const source = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx', import.meta.url),
      'utf-8',
    )

    expect(source).not.toContain('window.prompt')
    expect(source).toContain('SiteCreateDialog')
  })

  it('Site group shows pages and components, not code files or media', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    const panel = screen.getByTestId('site-explorer-panel')
    expect(within(panel).getByRole('heading', { name: 'Pages' })).toBeDefined()
    expect(within(panel).getByRole('heading', { name: 'Components' })).toBeDefined()
    // Styles / Scripts live in the Code group; media assets never appear here.
    expect(within(panel).queryByRole('heading', { name: 'Styles' })).toBeNull()
    expect(within(panel).queryByRole('heading', { name: 'Scripts' })).toBeNull()
    expect(within(panel).queryByRole('heading', { name: 'Assets' })).toBeNull()

    expect(within(panel).getByRole('button', { name: /open page home/i })).toBeDefined()
    expect(within(panel).getByRole('button', { name: /open component herocard/i })).toBeDefined()
    expect(within(panel).queryByText('theme.css')).toBeNull()
    expect(within(panel).queryByText('analytics.ts')).toBeNull()
    expect(within(panel).queryByText('logo.svg')).toBeNull()
  })

  it('Code group shows stylesheets and scripts, not pages or components', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="code" />)

    const panel = screen.getByTestId('site-explorer-panel')
    expect(within(panel).getByRole('heading', { name: 'Styles' })).toBeDefined()
    expect(within(panel).getByRole('heading', { name: 'Scripts' })).toBeDefined()
    expect(within(panel).queryByRole('heading', { name: 'Pages' })).toBeNull()
    expect(within(panel).queryByRole('heading', { name: 'Components' })).toBeNull()

    expect(within(panel).getByText('theme.css')).toBeDefined()
    expect(within(panel).getByText('analytics.ts')).toBeDefined()
    // Media assets (logo.svg) never surface in the source-file groups.
    expect(within(panel).queryByText('logo.svg')).toBeNull()
  })

  it('renders Pages as a tree with the homepage pinned first', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    const panel = screen.getByTestId('site-explorer-panel')
    const pagesTree = within(panel).getByRole('tree', { name: 'Pages' })
    const rows = within(pagesTree).getAllByRole('treeitem')

    expect(rows[0].textContent).toContain('Home')
    expect(rows[0].getAttribute('data-pinned')).toBe('true')
    expect(rows[0].getAttribute('draggable')).not.toBe('true')
  })

  it('renders nested page and script paths as recursive folders', () => {
    loadSite()
    useEditorStore.setState((state) => {
      if (!state.site) return
      state.site.pages.push(makePage({
        id: 'page-docs',
        title: 'Documentation',
        slug: 'documentation',
        rootNodeId: 'root-docs',
        nodes: { 'root-docs': makeNode({ id: 'root-docs', moduleId: 'base.body' }) },
      }))
      state.site.pages.push(makePage({
        id: 'page-setup',
        title: 'Setup',
        slug: 'documentation/setup',
        rootNodeId: 'root-setup',
        nodes: { 'root-setup': makeNode({ id: 'root-setup', moduleId: 'base.body' }) },
      }))
      state.site.files.push({
        id: 'script-vendor',
        path: 'documentation/assets/js/vendor/jquery.min.js',
        type: 'script',
        content: '',
        createdAt: 1,
        updatedAt: 1,
      })
    })

    const { unmount } = render(<SiteExplorerPanel sectionGroup="site" />)

    const sitePanel = screen.getByTestId('site-explorer-panel')
    const pagesTree = within(sitePanel).getByRole('tree', { name: 'Pages' })
    expect(within(pagesTree).getByRole('button', { name: 'documentation' })).toBeDefined()
    expect(within(pagesTree).getByRole('button', { name: /open page setup/i })).toBeDefined()
    unmount()

    render(<SiteExplorerPanel sectionGroup="code" />)
    const codePanel = screen.getByTestId('site-explorer-panel')
    const scriptsTree = within(codePanel).getByRole('tree', { name: 'Scripts' })
    expect(within(scriptsTree).getByRole('button', { name: 'assets' })).toBeDefined()
    expect(within(scriptsTree).getByRole('button', { name: 'js' })).toBeDefined()
  })

  it('confirms structural folder rename with exact descendant slug changes', () => {
    loadSite()
    useEditorStore.setState((state) => {
      if (!state.site) return
      state.site.pages.push(makePage({
        id: 'page-docs',
        title: 'Documentation',
        slug: 'documentation',
        rootNodeId: 'root-docs',
        nodes: { 'root-docs': makeNode({ id: 'root-docs', moduleId: 'base.body' }) },
      }))
      state.site.pages.push(makePage({
        id: 'page-setup',
        title: 'Setup',
        slug: 'documentation/setup',
        rootNodeId: 'root-setup',
        nodes: { 'root-setup': makeNode({ id: 'root-setup', moduleId: 'base.body' }) },
      }))
    })

    render(<SiteExplorerPanel sectionGroup="site" />)

    const pagesTree = within(screen.getByTestId('site-explorer-panel')).getByRole('tree', { name: 'Pages' })
    fireEvent.contextMenu(within(pagesTree).getByRole('button', { name: 'documentation' }), {
      clientX: 120,
      clientY: 160,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))
    const input = screen.getByRole('textbox', { name: 'Rename documentation' })
    fireEvent.change(input, { target: { value: 'docs' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const dialog = screen.getByRole('dialog', { name: /rename documentation to docs/i })
    expect(within(dialog).getByText('documentation/setup')).toBeDefined()
    expect(within(dialog).getByText('docs/setup')).toBeDefined()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))

    const slugs = useEditorStore.getState().site!.pages.map((page) => page.slug).sort()
    expect(slugs).toEqual(['docs', 'docs/setup', 'index', 'pricing'])
  })

  it('confirms structural folder delete with exact descendants', () => {
    loadSite()
    useEditorStore.setState((state) => {
      if (!state.site) return
      state.site.pages.push(makePage({
        id: 'page-docs',
        title: 'Documentation',
        slug: 'documentation',
        rootNodeId: 'root-docs',
        nodes: { 'root-docs': makeNode({ id: 'root-docs', moduleId: 'base.body' }) },
      }))
      state.site.pages.push(makePage({
        id: 'page-setup',
        title: 'Setup',
        slug: 'documentation/setup',
        rootNodeId: 'root-setup',
        nodes: { 'root-setup': makeNode({ id: 'root-setup', moduleId: 'base.body' }) },
      }))
    })

    render(<SiteExplorerPanel sectionGroup="site" />)

    const pagesTree = within(screen.getByTestId('site-explorer-panel')).getByRole('tree', { name: 'Pages' })
    fireEvent.contextMenu(within(pagesTree).getByRole('button', { name: 'documentation' }), {
      clientX: 120,
      clientY: 160,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))

    const dialog = screen.getByRole('alertdialog', { name: /delete documentation/i })
    expect(within(dialog).getByText('documentation')).toBeDefined()
    expect(within(dialog).getByText('documentation/setup')).toBeDefined()
    expect(useEditorStore.getState().site?.pages.some((page) => page.id === 'page-docs')).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    const pageIds = useEditorStore.getState().site!.pages.map((page) => page.id)
    expect(pageIds).toEqual(['page-home', 'page-pricing'])
  })

  it('uses left-aligned tree row buttons and DOM-panel-style drop helpers', () => {
    const treeSectionSource = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerTreeSection.tsx', import.meta.url),
      'utf-8',
    )
    const treeRowsSource = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerTreeRows.tsx', import.meta.url),
      'utf-8',
    )
    const panelSource = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx', import.meta.url),
      'utf-8',
    )
    const dndScopeSource = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerDndScope.tsx', import.meta.url),
      'utf-8',
    )
    const editorBodySource = readFileSync(
      new URL('../../admin/layouts/AdminCanvasLayout/AdminCanvasEditorBody.tsx', import.meta.url),
      'utf-8',
    )
    const treeDropCss = readFileSync(
      new URL('../../admin/pages/site/ui/Tree/TreeDrop.module.css', import.meta.url),
      'utf-8',
    )
    const css = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.module.css', import.meta.url),
      'utf-8',
    )

    expect(treeRowsSource).toContain('align="start"')
    expect(treeSectionSource).toContain('treeDropStyles')
    expect(treeRowsSource).toContain('treeDropStyles')
    expect(treeRowsSource).toContain('data-drop-position')
    expect(treeSectionSource).toContain('RootDropGap')
    expect(dndScopeSource).toContain('DragOverlay')
    expect(editorBodySource).toContain('collisionDetection={pointerWithin}')
    expect(css).toContain('justify-content: flex-start')
    expect(css).toMatch(/\.treeRows\s*\{[^}]*gap:\s*0/s)
    expect(css).not.toContain('.dropBefore::before')
    expect(css).not.toContain('.dropAfter::after')
    expect(css).not.toContain('.rootDropGapActive::after')
    expect(treeDropCss).toContain('.dropBefore::before')
    expect(treeDropCss).toContain('.dropAfter::after')
    expect(treeDropCss).toContain('.rootDropGapActive::after')
    expect(treeDropCss).toContain('.dropInside')
    expect(css).toContain('.dragOverlayRow')

    const beforeAfterBlock = treeDropCss.match(/\.dropBefore::before,\n\.dropAfter::after,\n\.dropRoot::after,\n\.rootDropGapActive::after\s*\{[^}]*\}/s)?.[0] ?? ''
    expect(beforeAfterBlock).toContain('position: absolute')
    expect(beforeAfterBlock).not.toMatch(/(?:^|\n)\s*(margin|padding)\b/)

    const rootGapBlocks = [...treeDropCss.matchAll(/\.rootDropGap\s*\{[^}]*\}/g)]
    const rootGapBlock = rootGapBlocks[rootGapBlocks.length - 1]?.[0] ?? ''
    expect(rootGapBlock).toContain('height: 12px')
    expect(rootGapBlock).toContain('margin-block: calc(var(--space-xs) * -1)')
  })

  it('uses inline rename in Site Explorer and keeps the shared rename dialog chrome valid elsewhere', () => {
    const renameSource = readFileSync(
      new URL('../../admin/pages/site/explorer-actions/ExplorerRenameDialog.tsx', import.meta.url),
      'utf-8',
    )
    const panelSource = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx', import.meta.url),
      'utf-8',
    )
    const treeSectionSource = readFileSync(
      new URL('../../admin/pages/site/panels/SiteExplorerPanel/SiteExplorerTreeRows.tsx', import.meta.url),
      'utf-8',
    )

    expect(renameSource).toContain("import { Dialog } from '@ui/components/Dialog'")
    expect(renameSource).not.toContain('createPortal')
    expect(renameSource).not.toContain('styles.backdrop')
    expect(renameSource).not.toContain('styles.dialog')
    expect(panelSource).not.toContain('ExplorerRenameDialog')
    expect(treeSectionSource).toContain('InlineRenameInput')
  })

  it('renders page folders and nested page rows from explorer organization', () => {
    loadSite()
    useEditorStore.getState().renamePage('page-pricing', 'Pricing', 'marketing/pricing')

    render(<SiteExplorerPanel sectionGroup="site" />)

    const pagesTree = within(screen.getByTestId('site-explorer-panel')).getByRole('tree', { name: 'Pages' })
    expect(within(pagesTree).getByRole('treeitem', { name: 'marketing' })).toBeDefined()
    const pricingRow = within(pagesTree).getByRole('treeitem', { name: /open page pricing/i })
    expect(pricingRow.getAttribute('aria-level')).toBe('2')
  })

  it('supports Cmd/Ctrl multi-select for site explorer rows', () => {
    loadSite()
    useEditorStore.getState().addPage('About', 'about')

    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: /open page pricing/i }), { metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: /open page about/i }), { metaKey: true })

    expect(rowForButton(/open page pricing/i).getAttribute('aria-selected')).toBe('true')
    expect(rowForButton(/open page about/i).getAttribute('aria-selected')).toBe('true')
  })

  it('supports Shift range selection inside a site explorer section', () => {
    loadSite()
    useEditorStore.getState().addPage('About', 'about')

    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: /open page pricing/i }))
    fireEvent.click(screen.getByRole('button', { name: /open page about/i }), { shiftKey: true })

    expect(rowForButton(/open page pricing/i).getAttribute('aria-selected')).toBe('true')
    expect(rowForButton(/open page about/i).getAttribute('aria-selected')).toBe('true')
  })

  it('wraps selected components in a decorative folder from the item context menu', () => {
    loadSite()
    const footerId = useEditorStore.getState().createVisualComponent('FooterCard')

    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: /open component herocard/i }), { metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: /open component footercard/i }), { metaKey: true })
    fireEvent.contextMenu(screen.getByRole('button', { name: /open component herocard/i }), {
      clientX: 120,
      clientY: 140,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /wrap 2 components in folder/i }))

    const folder = useEditorStore.getState().site?.explorer.components.folders.find((entry) => entry.name === 'New folder')
    expect(folder).toBeDefined()
    const placements = useEditorStore.getState().site?.explorer.components.items ?? []
    expect(placements.find((item) => item.id === 'vc-HeroCard')?.parentFolderId).toBe(folder?.id)
    expect(placements.find((item) => item.id === footerId)?.parentFolderId).toBe(folder?.id)
  })

  it('shows bulk-specific actions for a site explorer multi-selection context menu', () => {
    loadSite()
    useEditorStore.getState().addPage('About', 'about')

    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: /open page pricing/i }), { metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: /open page about/i }), { metaKey: true })
    fireEvent.contextMenu(screen.getByRole('button', { name: /open page pricing/i }), {
      clientX: 120,
      clientY: 140,
    })

    expect(screen.getByText('2 pages selected')).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: /wrap 2 pages in folder/i })).toBeNull()
    expect(screen.getByRole('menuitem', { name: /delete 2 pages/i })).toBeDefined()
    expect(screen.queryByRole('menuitem', { name: /open in new tab/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /use as template/i })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /^rename$/i })).toBeNull()
  })

  it('interleaves root folders and root items by their explorer order', () => {
    loadSite()
    const folderPath = useEditorStore.getState().createExplorerFolder('pages', 'Marketing')
    useEditorStore.getState().moveStructuralExplorerRow('pages', { kind: 'folder', id: folderPath }, 1)

    render(<SiteExplorerPanel sectionGroup="site" />)

    const pagesTree = within(screen.getByTestId('site-explorer-panel')).getByRole('tree', { name: 'Pages' })
    const rows = within(pagesTree).getAllByRole('treeitem')
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Home/',
      'Pricing/pricing',
      'marketing',
    ])
  })

  it('Media Explorer uses CMS media instead of base64 site files', () => {
    const source = readFileSync(
      new URL('../../admin/pages/site/panels/MediaExplorerPanel/MediaExplorerPanel.tsx', import.meta.url),
      'utf-8',
    )

    expect(source).not.toContain('mediaMode')
    expect(source).not.toContain('ProjectMediaRows')
    expect(source).toContain('listCmsMediaAssets')
    expect(source).toContain('uploadCmsMediaAsset')
  })

  it('groups CMS media assets by image and video categories, dropping non-media files', async () => {
    loadSite()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        assets: [
          { id: 'media-image', filename: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 12, publicPath: '/uploads/logo.svg', uploadedByUserId: null, createdAt: '2026-01-03T00:00:00.000Z' },
          { id: 'media-video', filename: 'intro.mp4', mimeType: 'video/mp4', sizeBytes: 24, publicPath: '/uploads/intro.mp4', uploadedByUserId: null, createdAt: '2026-01-03T00:00:00.000Z' },
          { id: 'media-other', filename: 'catalog.pdf', mimeType: 'application/pdf', sizeBytes: 36, publicPath: '/uploads/catalog.pdf', uploadedByUserId: null, createdAt: '2026-01-03T00:00:00.000Z' },
        ],
      }), { status: 200 })) as typeof fetch

    try {
      render(<MediaExplorerPanel variant="tab" />)

      const panel = screen.getByTestId('media-explorer-panel')
      expect(within(panel).getByRole('heading', { name: 'Images' })).toBeDefined()
      expect(within(panel).getByRole('heading', { name: 'Videos' })).toBeDefined()
      expect(within(panel).queryByRole('heading', { name: 'Other' })).toBeNull()
      expect(await within(panel).findByRole('button', { name: /open media logo\.svg/i })).toBeDefined()
      expect(await within(panel).findByRole('button', { name: /open media intro\.mp4/i })).toBeDefined()
      // Non-media files are dropped entirely — no "Other" bucket to land in.
      expect(within(panel).queryByRole('button', { name: /open media catalog\.pdf/i })).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('filters media by search text and defaults to the grid view, togglable to list', async () => {
    loadSite()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        assets: [
          { id: 'media-image', filename: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 12, publicPath: '/uploads/logo.svg', uploadedByUserId: null, createdAt: '2026-01-03T00:00:00.000Z' },
          { id: 'media-video', filename: 'intro.mp4', mimeType: 'video/mp4', sizeBytes: 24, publicPath: '/uploads/intro.mp4', uploadedByUserId: null, createdAt: '2026-01-03T00:00:00.000Z' },
        ],
      }), { status: 200 })) as typeof fetch

    try {
      render(<MediaExplorerPanel variant="tab" />)

      const panel = screen.getByTestId('media-explorer-panel')
      await within(panel).findByRole('button', { name: /open media intro\.mp4/i })

      // Grid is the default view — no prior list-mode preference stored.
      expect(within(panel).getByRole('button', { name: /grid view/i }).getAttribute('aria-pressed')).toBe('true')
      expect(within(panel).getByRole('button', { name: /list view/i }).getAttribute('aria-pressed')).toBe('false')
      expect(within(panel).getByTestId('media-grid-images')).toBeDefined()
      expect(within(panel).getByTestId('media-grid-videos')).toBeDefined()

      fireEvent.change(within(panel).getByRole('searchbox', { name: /search media/i }), {
        target: { value: 'intro' },
      })

      expect(within(panel).queryByRole('button', { name: /open media logo\.svg/i })).toBeNull()
      expect(within(panel).getByRole('button', { name: /open media intro\.mp4/i })).toBeDefined()

      fireEvent.change(within(panel).getByRole('searchbox', { name: /search media/i }), {
        target: { value: '' },
      })
      fireEvent.click(within(panel).getByRole('button', { name: /list view/i }))

      expect(within(panel).getByRole('button', { name: /list view/i }).getAttribute('aria-pressed')).toBe('true')
      expect(within(panel).queryByTestId('media-grid-images')).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('copies asset URLs from the media context menu', async () => {
    loadSite()
    const originalFetch = globalThis.fetch
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text
        },
      },
    })
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        assets: [{
          id: 'media-1',
          filename: 'hero.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          publicPath: '/uploads/hero.png',
          uploadedByUserId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        }],
      }), { status: 200 })) as typeof fetch

    try {
      render(<MediaExplorerPanel variant="tab" />)

      const mediaRow = await screen.findByRole('button', { name: /open media hero\.png/i })
      fireEvent.contextMenu(mediaRow, { clientX: 120, clientY: 140 })
      fireEvent.click(screen.getByRole('menuitem', { name: /copy url/i }))

      await waitFor(() => {
        expect(copied).toBe('/uploads/hero.png')
      })
    } finally {
      globalThis.fetch = originalFetch
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard)
      } else {
        delete (navigator as typeof navigator & { clipboard?: Clipboard }).clipboard
      }
    }
  })

  it('applies image and video assets to the selected media modules', async () => {
    loadSite()
    const state = useEditorStore.getState()
    const site = structuredClone(state.site)
    if (!site) throw new Error('Expected site fixture')
    const home = site.pages.find((page) => page.id === 'page-home')
    if (!home) throw new Error('Expected home page fixture')
    home.nodes['image-node'] = makeNode({
      id: 'image-node',
      moduleId: 'base.image',
      props: { src: '', loading: 'lazy' },
    })
    home.nodes['video-node'] = makeNode({
      id: 'video-node',
      moduleId: 'base.video',
      props: {
        videoUrl: '',
        autoplay: false,
        loop: false,
        muted: false,
        controls: true,
      },
    })
    home.nodes['root-home'] = {
      ...home.nodes['root-home'],
      children: ['image-node', 'video-node'],
    }
    useEditorStore.setState({
      site,
      selectedNodeId: 'image-node',
    } as Parameters<typeof useEditorStore.setState>[0])

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        assets: [
          {
            id: 'media-image',
            filename: 'hero.png',
            mimeType: 'image/png',
            sizeBytes: 12,
            publicPath: '/uploads/hero.png',
            uploadedByUserId: null,
            createdAt: '2026-01-03T00:00:00.000Z',
          },
          {
            id: 'media-video',
            filename: 'intro.mp4',
            mimeType: 'video/mp4',
            sizeBytes: 24,
            publicPath: '/uploads/intro.mp4',
            uploadedByUserId: null,
            createdAt: '2026-01-03T00:00:00.000Z',
          },
        ],
      }), { status: 200 })) as typeof fetch

    try {
      render(<MediaExplorerPanel variant="tab" />)

      const imageRow = await screen.findByRole('button', { name: /open media hero\.png/i })
      fireEvent.contextMenu(imageRow, { clientX: 120, clientY: 140 })
      fireEvent.click(screen.getByRole('menuitem', { name: /use in selected image/i }))

      expect(useEditorStore.getState().site?.pages[0]?.nodes['image-node']?.props.src).toBe('/uploads/hero.png')

      act(() => {
        useEditorStore.setState({ selectedNodeId: 'video-node' } as Parameters<typeof useEditorStore.setState>[0])
      })
      const videoRow = await screen.findByRole('button', { name: /open media intro\.mp4/i })
      fireEvent.contextMenu(videoRow, { clientX: 120, clientY: 140 })
      fireEvent.click(screen.getByRole('menuitem', { name: /use in selected video/i }))

      const videoProps = useEditorStore.getState().site?.pages[0]?.nodes['video-node']?.props
      expect(videoProps?.videoUrl).toBe('/uploads/intro.mp4')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('opens CMS media assets in the dedicated viewer window instead of navigating away', async () => {
    loadSite()
    const originalFetch = globalThis.fetch
    const originalOpen = window.open
    const openCalls: unknown[] = []
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        assets: [{
          id: 'media-1',
          filename: 'hero.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          publicPath: '/uploads/hero.png',
          uploadedByUserId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        }],
      }), { status: 200 })) as typeof fetch
    window.open = ((...args: unknown[]) => {
      openCalls.push(args)
      return null
    }) as typeof window.open

    try {
      render(<MediaExplorerPanel variant="tab" />)

      const mediaRow = await screen.findByRole('button', { name: /open media hero\.png/i })
      fireEvent.click(mediaRow)

      // The new viewer is a portal-rendered <aside role="dialog"> with the
      // filename in its aria-label. CodeEditorPanel is no longer involved.
      const viewer = await screen.findByRole('dialog', { name: /viewer: hero\.png/i })
      expect(viewer).toBeDefined()
      expect(openCalls).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
      window.open = originalOpen
    }
  })

  it('floats the code editor above the docked sidebars', () => {
    const editorPanelCss = readFileSync(
      new URL('../../admin/pages/site/code-editor/CodeEditorPanel.module.css', import.meta.url),
      'utf-8',
    )
    const leftSidebarCss = readFileSync(
      new URL('../../admin/pages/site/sidebars/LeftSidebar/LeftSidebar.module.css', import.meta.url),
      'utf-8',
    )
    const rightSidebarCss = readFileSync(
      new URL('../../admin/pages/site/sidebars/RightSidebar/RightSidebar.module.css', import.meta.url),
      'utf-8',
    )

    const panelRule = editorPanelCss.match(/\.panel\s*\{[\s\S]*?\}/)?.[0] ?? ''
    const panelZIndex = Number(panelRule.match(/z-index:\s*(\d+)/)?.[1])
    const sidebarZIndexes = [leftSidebarCss, rightSidebarCss]
      .flatMap((css) => [...css.matchAll(/z-index:\s*(\d+)/g)].map((match) => Number(match[1])))

    expect(panelRule).toContain('position: fixed;')
    // The code editor is a focused, draggable surface — it must float OVER the
    // docked Explorer panel / sidebars, not hide behind them.
    expect(panelZIndex).toBeGreaterThan(Math.max(...sidebarZIndexes))
  })

  it('opens pages and components on the canvas from concept rows', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: /open page pricing/i }))
    expect(useEditorStore.getState().activePageId).toBe('page-pricing')
    expect(useEditorStore.getState().activeDocument).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /open component herocard/i }))
    expect(useEditorStore.getState().activeDocument).toEqual({
      kind: 'visualComponent',
      vcId: 'vc-HeroCard',
    })
  })

  it('opens page routes in a new browser tab from the page context menu', () => {
    loadSite()
    const originalOpen = window.open
    const openCalls: unknown[] = []
    window.open = ((...args: unknown[]) => {
      openCalls.push(args)
      return null
    }) as typeof window.open

    try {
      render(<SiteExplorerPanel sectionGroup="site" />)

      fireEvent.contextMenu(screen.getByRole('button', { name: /open page pricing/i }), {
        clientX: 120,
        clientY: 140,
      })
      fireEvent.click(screen.getByRole('menuitem', { name: /open in new tab/i }))

      expect(openCalls).toEqual([['/pricing', '_blank', 'noopener,noreferrer']])
    } finally {
      window.open = originalOpen
    }
  })

  it('creates pages with an editable slug through the site dialog', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: 'New page' }))

    const dialog = screen.getByRole('dialog', { name: 'New page' })
    expect(within(dialog).queryByText(/src\/pages/i)).toBeNull()
    expect(within(dialog).queryByText(/home\.tsx/i)).toBeNull()

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'About Us' },
    })
    expect((within(dialog).getByLabelText('Slug') as HTMLInputElement).value).toBe('about-us')

    fireEvent.change(within(dialog).getByLabelText('Slug'), {
      target: { value: 'company' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    const state = useEditorStore.getState()
    const created = state.site?.pages.find((page) => page.title === 'About Us')
    expect(created?.slug).toBe('company')
    expect(state.activePageId).toBe(created?.id)
    expect(state.activeDocument).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'New page' })).toBeNull()
  })

  it('creates components through the simple site dialog', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: 'New component' }))

    const dialog = screen.getByRole('dialog', { name: 'New component' })
    expect(within(dialog).queryByText(/src\/components/i)).toBeNull()

    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'feature row' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    const state = useEditorStore.getState()
    // Component names are stored verbatim (free-form, no PascalCase coercion).
    const created = state.site?.visualComponents.find((component) => component.name === 'feature row')
    expect(created).toBeDefined()
    expect(state.activeDocument).toEqual({
      kind: 'visualComponent',
      vcId: created?.id,
    })
  })

  it('creates styles and scripts through the simple site dialog', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="code" />)

    fireEvent.click(screen.getByRole('button', { name: 'New stylesheet' }))
    let dialog = screen.getByRole('dialog', { name: 'New stylesheet' })
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'landing' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    let state = useEditorStore.getState()
    const styleFile = state.site?.files.find((file) => file.path === 'src/styles/landing.css')
    expect(styleFile?.type).toBe('style')
    expect(state.activeEditorFileId).toBe(styleFile?.id)

    fireEvent.click(screen.getByRole('button', { name: 'New script' }))
    dialog = screen.getByRole('dialog', { name: 'New script' })
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'tracking' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    state = useEditorStore.getState()
    const scriptFile = state.site?.files.find((file) => file.path === 'src/scripts/tracking.ts')
    expect(scriptFile?.type).toBe('script')
    expect(state.activeEditorFileId).toBe(scriptFile?.id)
  })

  it('renames and deletes pages from the site row context menu', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /open page pricing/i }), {
      clientX: 120,
      clientY: 140,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))

    const input = screen.getByRole('textbox', { name: 'Rename Pricing' })
    fireEvent.change(input, {
      target: { value: 'Plans' },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    let renamed = useEditorStore.getState().site?.pages.find((page) => page.id === 'page-pricing')
    expect(renamed?.title).toBe('Plans')
    expect(renamed?.slug).toBe('pricing')

    fireEvent.contextMenu(screen.getByRole('button', { name: /open page plans/i }), {
      clientX: 120,
      clientY: 140,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))

    renamed = useEditorStore.getState().site?.pages.find((page) => page.id === 'page-pricing')
    expect(renamed).toBeUndefined()
  })

  it('opens inline page rename from a double-clicked site row', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.doubleClick(screen.getByRole('button', { name: /open page pricing/i }))

    expect(screen.getByRole('textbox', { name: 'Rename Pricing' })).toBeDefined()
  })

  it('renames and deletes components from the site row context menu', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /open component herocard/i }), {
      clientX: 120,
      clientY: 180,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))

    const input = screen.getByRole('textbox', { name: 'Rename HeroCard' })
    fireEvent.change(input, {
      target: { value: 'Promo card' },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    let component = useEditorStore.getState().site?.visualComponents.find((item) => item.id === 'vc-HeroCard')
    // Component names are stored verbatim (free-form, no PascalCase coercion).
    expect(component?.name).toBe('Promo card')

    fireEvent.contextMenu(screen.getByRole('button', { name: /open component promo card/i }), {
      clientX: 120,
      clientY: 180,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))

    component = useEditorStore.getState().site?.visualComponents.find((item) => item.id === 'vc-HeroCard')
    expect(component).toBeUndefined()
  })

  it('renames and deletes code files from the site row context menu', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="code" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /open theme\.css/i }), {
      clientX: 120,
      clientY: 220,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))

    const input = screen.getByRole('textbox', { name: 'Rename theme.css' })
    fireEvent.change(input, {
      target: { value: 'src/styles/site.css' },
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    const styleFile = useEditorStore.getState().site?.files.find((file) => file.id === 'style-1')
    expect(styleFile?.path).toBe('src/styles/site.css')

    fireEvent.contextMenu(screen.getByRole('button', { name: /open analytics\.ts/i }), {
      clientX: 120,
      clientY: 260,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))

    const scriptFile = useEditorStore.getState().site?.files.find((file) => file.id === 'script-1')
    expect(scriptFile).toBeUndefined()
  })

  it('does not expose a drag-to-canvas handle on Component rows', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    const panel = screen.getByTestId('site-explorer-panel')
    expect(within(panel).queryByTestId('site-explorer-component-drag-handle')).toBeNull()
  })

  it('clicking a Component row still navigates to VC edit', () => {
    loadSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.click(screen.getByRole('button', { name: /open component herocard/i }))
    expect(useEditorStore.getState().activeDocument).toEqual({
      kind: 'visualComponent',
      vcId: 'vc-HeroCard',
    })
  })

  it('renames and deletes CMS media assets from the media row context menu', async () => {
    loadSite()
    const originalFetch = globalThis.fetch
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init })
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({
          asset: {
            id: 'media-1',
            filename: 'Hero renamed.png',
            mimeType: 'image/png',
            sizeBytes: 12,
            publicPath: '/uploads/hero.png',
            uploadedByUserId: null,
            createdAt: '2026-01-03T00:00:00.000Z',
          },
        }), { status: 200 })
      }
      if (init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify({
        assets: [{
          id: 'media-1',
          filename: 'hero.png',
          mimeType: 'image/png',
          sizeBytes: 12,
          publicPath: '/uploads/hero.png',
          uploadedByUserId: null,
          createdAt: '2026-01-03T00:00:00.000Z',
        }],
      }), { status: 200 })
    }) as typeof fetch

    try {
      render(<MediaExplorerPanel variant="tab" />)

      const mediaRow = await screen.findByRole('button', { name: /open media hero\.png/i })
      fireEvent.contextMenu(mediaRow, { clientX: 120, clientY: 140 })
      fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))

      const dialog = screen.getByRole('dialog', { name: 'Rename media' })
      fireEvent.change(within(dialog).getByLabelText('Name'), {
        target: { value: 'Hero renamed.png' },
      })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

      expect(await screen.findByRole('button', { name: /open media hero renamed\.png/i })).toBeDefined()
      expect(calls.some((call) => call.input === '/admin/api/cms/media/media-1' && call.init?.method === 'PATCH')).toBe(true)

      fireEvent.contextMenu(screen.getByRole('button', { name: /open media hero renamed\.png/i }), {
        clientX: 120,
        clientY: 140,
      })
      fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }))

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /open media hero renamed\.png/i })).toBeNull()
      })
      expect(calls.some((call) => call.input === '/admin/api/cms/media/media-1' && call.init?.method === 'DELETE')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
