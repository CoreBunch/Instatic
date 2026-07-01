import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { createDefaultSiteExplorerOrganization, type SiteDocument } from '@core/page-tree'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG } from '@core/site-runtime'
import type { VisualComponent } from '@core/visualComponents'
import { makeNode, makePage, makeSite } from '../fixtures'

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    activeEditorFileId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function makeVisualComponent(id: string, name: string): VisualComponent {
  const rootNodeId = `${id}-root`
  return {
    id,
    name,
    tree: {
      rootNodeId,
      nodes: {
        [rootNodeId]: {
          id: rootNodeId,
          moduleId: 'base.body',
          props: {},
          children: [],
          breakpointOverrides: {},
          classIds: [],
        },
      },
    },
    params: [],
    classIds: [],
    createdAt: 1,
  }
}

function loadExplorerSite(overrides: Partial<SiteDocument> = {}) {
  const home = makePage({
    id: 'home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: { 'root-home': makeNode({ id: 'root-home', moduleId: 'base.body' }) },
  })
  const pricing = makePage({
    id: 'pricing',
    title: 'Pricing',
    slug: 'pricing',
    rootNodeId: 'root-pricing',
    nodes: { 'root-pricing': makeNode({ id: 'root-pricing', moduleId: 'base.body' }) },
  })
  const site = makeSite({
    pages: [home, pricing],
    visualComponents: [makeVisualComponent('hero', 'Hero')],
    files: [
      {
        id: 'theme',
        path: 'src/styles/theme.css',
        type: 'style',
        content: '',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    explorer: createDefaultSiteExplorerOrganization(),
    ...overrides,
  })
  useEditorStore.getState().loadSite(site)
}

beforeEach(resetStore)

describe('Site Explorer organization store actions', () => {
  it('commits a structural page folder rename by rewriting descendant slugs', () => {
    loadExplorerSite({
      pages: [
        makePage({ id: 'home', slug: 'index', title: 'Home' }),
        makePage({ id: 'docs', slug: 'documentation', title: 'Docs' }),
        makePage({ id: 'setup', slug: 'documentation/setup', title: 'Setup' }),
      ],
    })

    const plan = useEditorStore.getState().previewRenameExplorerFolder('pages', 'documentation', 'docs')
    useEditorStore.getState().commitExplorerPathChange(plan)

    const slugs = useEditorStore.getState().site!.pages.map((page) => page.slug).sort()
    expect(slugs).toEqual(['docs', 'docs/setup', 'index'])
  })

  it('commits a structural page folder delete by deleting descendants', () => {
    loadExplorerSite({
      pages: [
        makePage({ id: 'home', slug: 'index', title: 'Home' }),
        makePage({ id: 'docs', slug: 'documentation', title: 'Docs' }),
        makePage({ id: 'setup', slug: 'documentation/setup', title: 'Setup' }),
        makePage({ id: 'pricing', slug: 'pricing', title: 'Pricing' }),
      ],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: ['documentation'],
          emptyFolders: [],
          rowOrder: [{ kind: 'folder', id: 'documentation', order: 0 }],
        },
      },
    })

    const plan = useEditorStore.getState().previewDeleteExplorerFolder('pages', 'documentation')
    useEditorStore.getState().commitExplorerPathChange(plan)

    const site = useEditorStore.getState().site!
    expect(site.pages.map((page) => page.id)).toEqual(['home', 'pricing'])
    expect(site.explorer.pages).toEqual({ expandedFolders: [], emptyFolders: [], rowOrder: [] })
  })

  it('renames a freshly created empty structural folder end-to-end without touching pages', () => {
    // A freshly created folder is collapsed — tracked in emptyFolders only,
    // which is exactly the "rewrite 0 paths" case that used to no-op on commit.
    loadExplorerSite({
      pages: [makePage({ id: 'home', slug: 'index', title: 'Home' })],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: [],
          emptyFolders: ['new-folder'],
          rowOrder: [{ kind: 'folder', id: 'new-folder', order: 0 }],
        },
      },
    })

    const plan = useEditorStore.getState().previewRenameExplorerFolder('pages', 'new-folder', 'link')
    useEditorStore.getState().commitExplorerPathChange(plan)

    const section = useEditorStore.getState().site!.explorer.pages
    expect(section.emptyFolders).toEqual(['link'])
    expect(section.rowOrder).toEqual([{ kind: 'folder', id: 'link', order: 0 }])
  })

  it('deletes a freshly created empty structural folder end-to-end', () => {
    loadExplorerSite({
      pages: [makePage({ id: 'home', slug: 'index', title: 'Home' })],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: [],
          emptyFolders: ['scratch'],
          rowOrder: [{ kind: 'folder', id: 'scratch', order: 0 }],
        },
      },
    })

    const plan = useEditorStore.getState().previewDeleteExplorerFolder('pages', 'scratch')
    useEditorStore.getState().commitExplorerPathChange(plan)

    expect(useEditorStore.getState().site!.explorer.pages).toEqual({
      expandedFolders: [],
      emptyFolders: [],
      rowOrder: [],
    })
  })

  it('commits a structural scripts folder delete and removes runtime config', () => {
    loadExplorerSite({
      files: [
        { id: 'main', path: 'documentation/assets/js/main.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'theme', path: 'src/styles/theme.css', type: 'style', content: '', createdAt: 1, updatedAt: 1 },
      ],
      runtime: {
        dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
        scripts: {
          main: DEFAULT_SCRIPT_RUNTIME_CONFIG,
        },
        styles: {},
      },
    })

    const plan = useEditorStore.getState().previewDeleteExplorerFolder('scripts', 'documentation/assets/js')
    useEditorStore.getState().commitExplorerPathChange(plan)

    expect(useEditorStore.getState().site!.files.some((file) => file.id === 'main')).toBe(false)
    expect(useEditorStore.getState().site!.runtime.scripts.main).toBeUndefined()
    expect(useEditorStore.getState().siteRuntime.scripts.main).toBeUndefined()
  })

  it('moves organization placement when a page becomes a template and back', () => {
    loadExplorerSite()

    useEditorStore.getState().convertPageToTemplate('pricing', {
      enabled: true,
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 0,
    })

    let explorer = useEditorStore.getState().site?.explorer
    expect(explorer?.pages.rowOrder.some((item) => item.id === 'pricing')).toBe(false)
    expect(explorer?.templates.items.some((item) => item.id === 'pricing')).toBe(true)

    useEditorStore.getState().convertTemplateToPage('pricing')

    explorer = useEditorStore.getState().site?.explorer
    expect(explorer?.templates.items.some((item) => item.id === 'pricing')).toBe(false)
    expect(explorer?.pages.rowOrder.some((item) => item.id === 'pricing')).toBe(false)
  })

  it('updates file and component placements when items are created and deleted', () => {
    loadExplorerSite()

    const scriptId = useEditorStore.getState().createFile('src/scripts/analytics.ts', 'script', '')
    const componentId = useEditorStore.getState().createVisualComponent('Promo')

    let explorer = useEditorStore.getState().site?.explorer
    expect(useEditorStore.getState().site?.files.some((file) => file.id === scriptId)).toBe(true)
    expect(explorer?.scripts).toEqual({ expandedFolders: [], emptyFolders: [], rowOrder: [] })
    expect(explorer?.components.items.some((item) => item.id === componentId)).toBe(true)

    useEditorStore.getState().deleteFile(scriptId)
    useEditorStore.getState().deleteVisualComponent(componentId)

    explorer = useEditorStore.getState().site?.explorer
    expect(useEditorStore.getState().site?.files.some((file) => file.id === scriptId)).toBe(false)
    expect(explorer?.components.items.some((item) => item.id === componentId)).toBe(false)
  })

  it('keeps decorative template folders using placement metadata', () => {
    loadExplorerSite()
    useEditorStore.getState().convertPageToTemplate('pricing', {
      enabled: true,
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 0,
    })

    const folderId = useEditorStore.getState().createExplorerFolder('templates', 'Layouts')
    useEditorStore.getState().moveExplorerItem('templates', 'pricing', folderId, 0)

    const explorer = useEditorStore.getState().site!.explorer
    expect(explorer.templates.folders).toEqual([{ id: folderId, name: 'Layouts', order: 0 }])
    expect(explorer.templates.items.find((item) => item.id === 'pricing')?.parentFolderId).toBe(folderId)
  })

  it('creates structural empty folders without creating page placements', () => {
    loadExplorerSite()

    const folderPath = useEditorStore.getState().createExplorerFolder('pages', 'Marketing')

    expect(folderPath).toBe('marketing')
    expect(useEditorStore.getState().site?.explorer.pages).toEqual({
      expandedFolders: [],
      emptyFolders: ['marketing'],
      rowOrder: [],
    })
  })

  it('sets a page as homepage and keeps pages structural', () => {
    loadExplorerSite()

    useEditorStore.getState().setPageAsHomepage('pricing')

    const site = useEditorStore.getState().site
    const pricing = site?.pages.find((page) => page.id === 'pricing')
    const previousHome = site?.pages.find((page) => page.id === 'home')
    expect(pricing?.slug).toBe('index')
    expect(previousHome?.slug).toBe('home')
    expect(site?.explorer.pages).toEqual({ expandedFolders: [], emptyFolders: [], rowOrder: [] })
  })

  it('blocks attempts to move the homepage into a folder', () => {
    loadExplorerSite()

    const plan = useEditorStore.getState().previewMoveExplorerItem('pages', 'home', 'marketing')

    expect(plan.blockers).toEqual([
      {
        code: 'homepage-protected',
        message: 'The homepage cannot be moved by folder operations.',
        target: 'index',
      },
    ])
    expect(() => useEditorStore.getState().commitExplorerPathChange(plan)).toThrow(
      '[SiteExplorer] Cannot commit a blocked path change plan',
    )
    expect(useEditorStore.getState().site?.pages.find((page) => page.id === 'home')?.slug).toBe('index')
  })
})
