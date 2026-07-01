import { describe, expect, it } from 'bun:test'
import {
  buildDeleteExplorerPathPlan,
  buildMoveExplorerFolderPlan,
  buildMoveExplorerItemPlan,
  buildRenameExplorerFolderPlan,
  commitExplorerPathPlan,
  createDefaultSiteExplorerOrganization,
} from '@core/page-tree'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG, DEFAULT_STYLE_RUNTIME_CONFIG } from '@core/site-runtime'
import { makePage, makeSite } from '../fixtures'

describe('site explorer path plans', () => {
  it('plans exact descendant page slug rewrites for folder rename', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index', title: 'Home' }),
        makePage({ id: 'docs', slug: 'documentation', title: 'Documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup', title: 'Setup' }),
      ],
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'documentation',
      nextFolderPath: 'docs',
    })

    expect(plan.blockers).toEqual([])
    expect(plan.changes.map((change) => [change.id, change.from, change.to])).toEqual([
      ['docs', 'documentation', 'docs'],
      ['setup', 'documentation/setup', 'docs/setup'],
    ])
  })

  it('blocks page slug collisions instead of auto-suffixing', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'docs', slug: 'documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup' }),
        makePage({ id: 'collision', slug: 'docs/setup' }),
      ],
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'documentation',
      nextFolderPath: 'docs',
    })

    expect(plan.blockers).toEqual([
      { code: 'duplicate-page-slug', message: 'Page slug "/docs/setup" already exists.', target: 'docs/setup' },
    ])
  })

  it('plans exact script path rewrites and keeps file ids', () => {
    const site = makeSite({
      files: [
        { id: 'main', path: 'documentation/assets/js/main.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'vendor', path: 'documentation/assets/js/vendor/jquery.min.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
      ],
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'scripts',
      folderPath: 'documentation/assets/js',
      nextFolderPath: 'documentation/assets/scripts',
    })

    expect(plan.blockers).toEqual([])
    expect(plan.changes.map((change) => [change.id, change.from, change.to])).toEqual([
      ['main', 'documentation/assets/js/main.js', 'documentation/assets/scripts/main.js'],
      ['vendor', 'documentation/assets/js/vendor/jquery.min.js', 'documentation/assets/scripts/vendor/jquery.min.js'],
    ])
  })

  it('plans structural folder delete as descendant deletion', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'docs', slug: 'documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup' }),
        makePage({ id: 'pricing', slug: 'pricing' }),
      ],
    })

    const plan = buildDeleteExplorerPathPlan(site, { sectionId: 'pages', folderPath: 'documentation' })

    expect(plan.deletedItems.map((item) => [item.id, item.path])).toEqual([
      ['docs', 'documentation'],
      ['setup', 'documentation/setup'],
    ])
  })

  it('commits rewrite plans exactly', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'about', slug: 'about' }),
      ],
    })
    const plan = buildMoveExplorerItemPlan(site, {
      sectionId: 'pages',
      itemId: 'about',
      nextParentPath: 'documentation',
    })

    commitExplorerPathPlan(site, undefined, plan)

    expect(site.pages.find((page) => page.id === 'about')?.slug).toBe('documentation/about')
  })

  it('commits file delete plans and removes matching runtime config', () => {
    const site = makeSite({
      files: [
        { id: 'theme', path: 'documentation/assets/css/theme.css', type: 'style', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'main', path: 'documentation/assets/js/main.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
        { id: 'keep', path: 'marketing/assets/js/keep.js', type: 'script', content: '', createdAt: 1, updatedAt: 1 },
      ],
      runtime: {
        dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
        styles: { theme: DEFAULT_STYLE_RUNTIME_CONFIG },
        scripts: {
          main: DEFAULT_SCRIPT_RUNTIME_CONFIG,
          keep: DEFAULT_SCRIPT_RUNTIME_CONFIG,
        },
      },
    })
    const liveRuntime = structuredClone(site.runtime)
    const stylesPlan = buildDeleteExplorerPathPlan(site, {
      sectionId: 'styles',
      folderPath: 'documentation/assets/css',
    })
    const scriptsPlan = buildDeleteExplorerPathPlan(site, {
      sectionId: 'scripts',
      folderPath: 'documentation/assets/js',
    })

    commitExplorerPathPlan(site, liveRuntime, stylesPlan)
    commitExplorerPathPlan(site, liveRuntime, scriptsPlan)

    expect(site.files.map((file) => file.id)).toEqual(['keep'])
    expect(site.runtime.styles.theme).toBeUndefined()
    expect(site.runtime.scripts.main).toBeUndefined()
    expect(site.runtime.scripts.keep).toEqual(DEFAULT_SCRIPT_RUNTIME_CONFIG)
    expect(liveRuntime.styles.theme).toBeUndefined()
    expect(liveRuntime.scripts.main).toBeUndefined()
    expect(liveRuntime.scripts.keep).toEqual(DEFAULT_SCRIPT_RUNTIME_CONFIG)
  })

  it('carries a folder-path change and rewrites bookkeeping for an empty folder rename', () => {
    const site = makeSite({
      pages: [makePage({ id: 'home', slug: 'index' })],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: ['new-folder'],
          emptyFolders: ['new-folder', 'new-folder/inner'],
          rowOrder: [{ kind: 'folder', id: 'new-folder', order: 0 }],
        },
      },
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'new-folder',
      nextFolderPath: 'link',
    })

    expect(plan.changes).toEqual([])
    expect(plan.folderPathChange).toEqual({ from: 'new-folder', to: 'link' })

    commitExplorerPathPlan(site, undefined, plan)

    expect(site.explorer.pages.emptyFolders).toEqual(['link', 'link/inner'])
    expect(site.explorer.pages.expandedFolders).toEqual(['link'])
    expect(site.explorer.pages.rowOrder).toEqual([{ kind: 'folder', id: 'link', order: 0 }])
  })

  it('rewrites bookkeeping when moving an empty folder under a new parent', () => {
    const site = makeSite({
      pages: [makePage({ id: 'home', slug: 'index' })],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: ['scratch'],
          emptyFolders: ['scratch'],
          rowOrder: [{ kind: 'folder', id: 'scratch', order: 0 }],
        },
      },
    })

    const plan = buildMoveExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'scratch',
      nextParentPath: 'docs',
    })

    expect(plan.blockers).toEqual([])
    expect(plan.folderPathChange).toEqual({ from: 'scratch', to: 'docs/scratch' })

    commitExplorerPathPlan(site, undefined, plan)

    expect(site.explorer.pages.emptyFolders).toEqual(['docs/scratch'])
    expect(site.explorer.pages.rowOrder).toEqual([{ kind: 'folder', id: 'docs/scratch', order: 0 }])
  })

  it('preserves folder expansion and order when renaming a non-empty folder', () => {
    const site = makeSite({
      pages: [
        makePage({ id: 'home', slug: 'index' }),
        makePage({ id: 'docs', slug: 'documentation' }),
        makePage({ id: 'setup', slug: 'documentation/setup' }),
      ],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: ['documentation'],
          emptyFolders: [],
          rowOrder: [{ kind: 'folder', id: 'documentation', order: 3 }],
        },
      },
    })

    const plan = buildRenameExplorerFolderPlan(site, {
      sectionId: 'pages',
      folderPath: 'documentation',
      nextFolderPath: 'docs',
    })

    commitExplorerPathPlan(site, undefined, plan)

    expect(site.pages.find((page) => page.id === 'docs')?.slug).toBe('docs')
    expect(site.explorer.pages.expandedFolders).toEqual(['docs'])
    expect(site.explorer.pages.rowOrder).toEqual([{ kind: 'folder', id: 'docs', order: 3 }])
  })

  it('removes empty-folder bookkeeping on delete even with no descendant items', () => {
    const site = makeSite({
      pages: [makePage({ id: 'home', slug: 'index' })],
      explorer: {
        ...createDefaultSiteExplorerOrganization(),
        pages: {
          expandedFolders: ['scratch'],
          emptyFolders: ['scratch', 'scratch/inner'],
          rowOrder: [{ kind: 'folder', id: 'scratch', order: 0 }],
        },
      },
    })

    const plan = buildDeleteExplorerPathPlan(site, { sectionId: 'pages', folderPath: 'scratch' })

    expect(plan.deletedItems).toEqual([])
    expect(plan.folderPath).toBe('scratch')

    commitExplorerPathPlan(site, undefined, plan)

    expect(site.explorer.pages).toEqual({ expandedFolders: [], emptyFolders: [], rowOrder: [] })
  })
})
