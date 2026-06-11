import { describe, expect, it } from 'bun:test'
import type { Page, SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { CmsAdapter } from '@core/persistence/cms'

function makePage(id: string, slug: string): Page {
  return {
    id,
    title: slug,
    slug,
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: [],
      },
    },
  }
}

function makeVC(id: string, name: string): VisualComponent {
  return {
    id,
    name,
    tree: {
      rootNodeId: 'vc-root',
      nodes: {
        'vc-root': {
          id: 'vc-root',
          moduleId: 'base.container',
          props: {},
          breakpointOverrides: {},
          children: [],
          classIds: [],
        },
      },
    },
    params: [],
    classIds: [],
    createdAt: 1000,
  }
}

function makeLayout(id: string, name: string): SavedLayout {
  return {
    id,
    name,
    rootNodeId: 'layout-root',
    nodes: {
      'layout-root': {
        id: 'layout-root',
        moduleId: 'base.container',
        props: {},
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
    classes: {},
    createdAt: 1000,
  }
}

function site(): SiteDocument {
  return {
    id: 'project_1',
    name: 'CMS Site',
    pages: [makePage('page_home', 'index')],
    files: [],
    visualComponents: [],
    layouts: [],
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: {
      colorTokens: {},
      shortcuts: {},
    },
    styleRules: {},
    createdAt: 1000,
    updatedAt: 2000,
  }
}

describe('CmsAdapter', () => {
  it('loads the single-site draft site from the CMS API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const adapter = new CmsAdapter(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ site: site() }), { status: 200 })
    })

    const loaded = await adapter.loadSite('ignored-in-single-site-mode')

    expect(loaded?.id).toBe('project_1')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/site',
      init: { method: 'GET', credentials: 'include' },
    })
  })

  it('saves the draft site to the CMS API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const adapter = new CmsAdapter(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    await adapter.saveSite(site())

    expect(calls[0].input).toBe('/admin/api/cms/site')
    expect(calls[0].init).toMatchObject({
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      site: { id: 'project_1', name: 'CMS Site' },
    })
  })

  it('returns undefined when no draft site exists yet', async () => {
    const adapter = new CmsAdapter(async () =>
      new Response(JSON.stringify({ error: 'draft site not found' }), { status: 404 }))

    await expect(adapter.loadSite('default')).resolves.toBeUndefined()
  })

  it('surfaces CMS save error messages from the API response body', async () => {
    const adapter = new CmsAdapter(async () =>
      new Response(JSON.stringify({ error: 'Duplicate page slug "/about"' }), { status: 400 }))

    await expect(adapter.saveSite(site())).rejects.toThrow('Duplicate page slug "/about"')
  })
})

// ---------------------------------------------------------------------------
// Incremental save wire shapes
//
// saveSite PUTs four bodies:
//   /site       → { site: <shell — no pages, visualComponents, or layouts> }
//   /pages      → { changedPages, pageIds, baselinePageIds? }
//   /components → { changedComponents, componentIds }
//   /layouts    → { changedLayouts, layoutIds }
//
// Only the pages/components/layouts named by opts.dirty ship in changed*; the
// FULL id rosters always go along so server-side reaping keeps full-replace
// semantics.
// ---------------------------------------------------------------------------

describe('CmsAdapter incremental save wire shapes', () => {
  function multiDocSite(): SiteDocument {
    return {
      ...site(),
      pages: [makePage('page-1', 'index'), makePage('page-2', 'about')],
      visualComponents: [makeVC('vc-1', 'Card'), makeVC('vc-2', 'Hero')],
      layouts: [makeLayout('layout-1', 'Hero section'), makeLayout('layout-2', 'Footer')],
    }
  }

  interface RecordedCall {
    input: RequestInfo | URL
    init?: RequestInit
  }

  function recordingAdapter() {
    const calls: RecordedCall[] = []
    const adapter = new CmsAdapter(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    return { adapter, calls }
  }

  function bodyOf(calls: RecordedCall[], path: string): Record<string, unknown> {
    const call = calls.find((c) => c.input === path)
    expect(call).toBeDefined()
    return JSON.parse(String(call!.init?.body)) as Record<string, unknown>
  }

  function ids(items: unknown): string[] {
    return (items as Array<{ id: string }>).map((item) => item.id)
  }

  it('full save (no opts.dirty) ships ALL pages/components plus the full rosters, no baseline', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite())

    const shellBody = bodyOf(calls, '/admin/api/cms/site')
    const shell = shellBody.site as Record<string, unknown>
    expect('pages' in shell).toBe(false)
    expect('visualComponents' in shell).toBe(false)
    expect('layouts' in shell).toBe(false)

    const pagesBody = bodyOf(calls, '/admin/api/cms/pages')
    expect(ids(pagesBody.changedPages)).toEqual(['page-1', 'page-2'])
    expect(pagesBody.pageIds).toEqual(['page-1', 'page-2'])
    expect('baselinePageIds' in pagesBody).toBe(false)

    const componentsBody = bodyOf(calls, '/admin/api/cms/components')
    expect(ids(componentsBody.changedComponents)).toEqual(['vc-1', 'vc-2'])
    expect(componentsBody.componentIds).toEqual(['vc-1', 'vc-2'])

    const layoutsBody = bodyOf(calls, '/admin/api/cms/layouts')
    expect(ids(layoutsBody.changedLayouts)).toEqual(['layout-1', 'layout-2'])
    expect(layoutsBody.layoutIds).toEqual(['layout-1', 'layout-2'])
  })

  it('dirty save ships ONLY the named pages but always the FULL pageIds roster', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: { all: false, pageIds: new Set(['page-2']), componentIds: new Set(), layoutIds: new Set() },
    })

    const pagesBody = bodyOf(calls, '/admin/api/cms/pages')
    expect(ids(pagesBody.changedPages)).toEqual(['page-2'])
    expect(pagesBody.pageIds).toEqual(['page-1', 'page-2'])

    // Nothing marked on the component/layout side — empty changed batch, full roster.
    const componentsBody = bodyOf(calls, '/admin/api/cms/components')
    expect(componentsBody.changedComponents).toEqual([])
    expect(componentsBody.componentIds).toEqual(['vc-1', 'vc-2'])

    const layoutsBody = bodyOf(calls, '/admin/api/cms/layouts')
    expect(layoutsBody.changedLayouts).toEqual([])
    expect(layoutsBody.layoutIds).toEqual(['layout-1', 'layout-2'])
  })

  it('components PUT mirrors the pages contract: named changedComponents, full componentIds roster', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: { all: false, pageIds: new Set(), componentIds: new Set(['vc-2']), layoutIds: new Set() },
    })

    const componentsBody = bodyOf(calls, '/admin/api/cms/components')
    expect(ids(componentsBody.changedComponents)).toEqual(['vc-2'])
    expect(componentsBody.componentIds).toEqual(['vc-1', 'vc-2'])

    const pagesBody = bodyOf(calls, '/admin/api/cms/pages')
    expect(pagesBody.changedPages).toEqual([])
    expect(pagesBody.pageIds).toEqual(['page-1', 'page-2'])
  })

  it('layouts PUT mirrors the same contract: named changedLayouts, full layoutIds roster', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: { all: false, pageIds: new Set(), componentIds: new Set(), layoutIds: new Set(['layout-2']) },
    })

    const layoutsBody = bodyOf(calls, '/admin/api/cms/layouts')
    expect(ids(layoutsBody.changedLayouts)).toEqual(['layout-2'])
    expect(layoutsBody.layoutIds).toEqual(['layout-1', 'layout-2'])

    const pagesBody = bodyOf(calls, '/admin/api/cms/pages')
    expect(pagesBody.changedPages).toEqual([])
  })

  it('includes baselinePageIds when provided and omits the key otherwise', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      baselinePageIds: ['page-1'],
      dirty: { all: false, pageIds: new Set(['page-2']), componentIds: new Set(), layoutIds: new Set() },
    })

    const pagesBody = bodyOf(calls, '/admin/api/cms/pages')
    expect(pagesBody.baselinePageIds).toEqual(['page-1'])

    // Components never carry a baseline — pages-only concurrency token (ISS-041).
    const componentsBody = bodyOf(calls, '/admin/api/cms/components')
    expect('baselinePageIds' in componentsBody).toBe(false)
  })

  it('dirty.all = true sends everything despite narrower id sets', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: { all: true, pageIds: new Set(['page-2']), componentIds: new Set(), layoutIds: new Set() },
    })

    const pagesBody = bodyOf(calls, '/admin/api/cms/pages')
    expect(ids(pagesBody.changedPages)).toEqual(['page-1', 'page-2'])
    expect(pagesBody.pageIds).toEqual(['page-1', 'page-2'])

    const componentsBody = bodyOf(calls, '/admin/api/cms/components')
    expect(ids(componentsBody.changedComponents)).toEqual(['vc-1', 'vc-2'])
    expect(componentsBody.componentIds).toEqual(['vc-1', 'vc-2'])

    const layoutsBody = bodyOf(calls, '/admin/api/cms/layouts')
    expect(ids(layoutsBody.changedLayouts)).toEqual(['layout-1', 'layout-2'])
    expect(layoutsBody.layoutIds).toEqual(['layout-1', 'layout-2'])
  })
})
