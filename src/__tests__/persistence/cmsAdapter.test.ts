import { describe, expect, it } from 'bun:test'
import type { Page, SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { CmsAdapter } from '@core/persistence/cms'
import { SaveConflictError } from '@core/persistence/saveConflict'

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

    expect(loaded?.site.id).toBe('project_1')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/site',
      init: { method: 'GET', credentials: 'include' },
    })
  })

  it('saves the draft site with ONE PUT to the transactional site-document endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const adapter = new CmsAdapter(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true, seq: 1 }), { status: 200 })
    })

    await adapter.saveSite(site())

    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe('/admin/api/cms/site-document')
    expect(calls[0].init).toMatchObject({
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      mode: 'replace',
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
// Save wire shapes — the transactional site-document protocol
//
// saveSite PUTs ONE body to /admin/api/cms/site-document:
//
//   { mode, site, changedPages, deletedPageIds,
//     changedComponents, deletedComponentIds,
//     changedLayouts, deletedLayoutIds }
//
//   - mode 'incremental' (opts.dirty, not all): only the rows named by the
//     dirty marks ship as changed*, plus the explicitly deleted ids. No
//     rosters, no baselines — unmentioned rows are untouched server-side.
//   - mode 'replace' (no opts.dirty, or dirty.all): the full collections
//     ship; deleted*Ids are empty and the server derives deletions.
// ---------------------------------------------------------------------------

describe('CmsAdapter save wire shapes', () => {
  function multiDocSite(): SiteDocument {
    return {
      ...site(),
      pages: [makePage('page-1', 'index'), makePage('page-2', 'about')],
      visualComponents: [makeVC('vc-1', 'Card'), makeVC('vc-2', 'Hero')],
      layouts: [makeLayout('layout-1', 'Hero section'), makeLayout('layout-2', 'Footer')],
    }
  }

  function emptyDirty() {
    return {
      all: false,
      pageIds: new Set<string>(),
      componentIds: new Set<string>(),
      layoutIds: new Set<string>(),
      deletedPageIds: new Set<string>(),
      deletedComponentIds: new Set<string>(),
      deletedLayoutIds: new Set<string>(),
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
      return new Response(JSON.stringify({ ok: true, seq: 1 }), { status: 200 })
    })
    return { adapter, calls }
  }

  function savedBody(calls: RecordedCall[]): Record<string, unknown> {
    expect(calls).toHaveLength(1)
    expect(calls[0].input).toBe('/admin/api/cms/site-document')
    return JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
  }

  function ids(items: unknown): string[] {
    return (items as Array<{ id: string }>).map((item) => item.id)
  }

  it('full save (no opts.dirty) ships mode=replace with ALL collections and empty deleted ids', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite())

    const body = savedBody(calls)
    expect(body.mode).toBe('replace')

    const shell = body.site as Record<string, unknown>
    expect('pages' in shell).toBe(false)
    expect('visualComponents' in shell).toBe(false)
    expect('layouts' in shell).toBe(false)

    expect(ids(body.changedPages)).toEqual(['page-1', 'page-2'])
    expect(ids(body.changedComponents)).toEqual(['vc-1', 'vc-2'])
    expect(ids(body.changedLayouts)).toEqual(['layout-1', 'layout-2'])
    expect(body.deletedPageIds).toEqual([])
    expect(body.deletedComponentIds).toEqual([])
    expect(body.deletedLayoutIds).toEqual([])
  })

  it('dirty save ships mode=incremental with ONLY the named rows — no rosters at all', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: { ...emptyDirty(), pageIds: new Set(['page-2']) },
    })

    const body = savedBody(calls)
    expect(body.mode).toBe('incremental')
    expect(ids(body.changedPages)).toEqual(['page-2'])
    expect(body.changedComponents).toEqual([])
    expect(body.changedLayouts).toEqual([])
    expect(body.deletedPageIds).toEqual([])
    // The reap-by-omission rosters are gone from the wire.
    expect('pageIds' in body).toBe(false)
    expect('componentIds' in body).toBe(false)
    expect('layoutIds' in body).toBe(false)
    expect('baselinePageIds' in body).toBe(false)
  })

  it('deleted-row marks ship as explicit deleted ids per collection', async () => {
    const { adapter, calls } = recordingAdapter()
    const doc = multiDocSite()
    // Simulate a deleted page-2 / vc-2 / layout-2: gone from the document,
    // present in the deleted marks.
    doc.pages = doc.pages.filter((p) => p.id !== 'page-2')
    doc.visualComponents = doc.visualComponents.filter((vc) => vc.id !== 'vc-2')
    doc.layouts = doc.layouts.filter((l) => l.id !== 'layout-2')

    await adapter.saveSite(doc, {
      dirty: {
        ...emptyDirty(),
        deletedPageIds: new Set(['page-2']),
        deletedComponentIds: new Set(['vc-2']),
        deletedLayoutIds: new Set(['layout-2']),
      },
    })

    const body = savedBody(calls)
    expect(body.mode).toBe('incremental')
    expect(body.changedPages).toEqual([])
    expect(body.deletedPageIds).toEqual(['page-2'])
    expect(body.deletedComponentIds).toEqual(['vc-2'])
    expect(body.deletedLayoutIds).toEqual(['layout-2'])
  })

  it('components and layouts mirror the pages contract', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: {
        ...emptyDirty(),
        componentIds: new Set(['vc-2']),
        layoutIds: new Set(['layout-1']),
      },
    })

    const body = savedBody(calls)
    expect(ids(body.changedComponents)).toEqual(['vc-2'])
    expect(ids(body.changedLayouts)).toEqual(['layout-1'])
    expect(body.changedPages).toEqual([])
  })

  it('dirty.all = true ships mode=replace with everything, despite narrower id sets', async () => {
    const { adapter, calls } = recordingAdapter()
    await adapter.saveSite(multiDocSite(), {
      dirty: { ...emptyDirty(), all: true, pageIds: new Set(['page-2']) },
    })

    const body = savedBody(calls)
    expect(body.mode).toBe('replace')
    expect(ids(body.changedPages)).toEqual(['page-1', 'page-2'])
    expect(ids(body.changedComponents)).toEqual(['vc-1', 'vc-2'])
    expect(ids(body.changedLayouts)).toEqual(['layout-1', 'layout-2'])
    expect(body.deletedPageIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Conflict-detection wire shapes — baseSeqs / shellBaseSeq + the 409 path
// ---------------------------------------------------------------------------

describe('CmsAdapter conflict protocol', () => {
  function emptyDirty() {
    return {
      all: false,
      pageIds: new Set<string>(),
      componentIds: new Set<string>(),
      layoutIds: new Set<string>(),
      deletedPageIds: new Set<string>(),
      deletedComponentIds: new Set<string>(),
      deletedLayoutIds: new Set<string>(),
    }
  }

  it('ships the base-seq subset covering exactly the changed + deleted rows, plus shellBaseSeq', async () => {
    const calls: Array<{ init?: RequestInit }> = []
    const adapter = new CmsAdapter(async (_input, init) => {
      calls.push({ init })
      return new Response(JSON.stringify({ ok: true, seq: 9 }), { status: 200 })
    })

    const doc = site()
    const result = await adapter.saveSite(doc, {
      dirty: {
        ...emptyDirty(),
        pageIds: new Set(['page_home']),
        deletedComponentIds: new Set(['vc-gone']),
      },
      baseSeqs: {
        page_home: 4,
        'vc-gone': 5,
        'unrelated-row': 99, // not shipped — must not leak onto the wire
      },
      shellBaseSeq: 7,
    })

    expect(result.seq).toBe(9)
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
    expect(body.baseSeqs).toEqual({ page_home: 4, 'vc-gone': 5 })
    expect(body.shellBaseSeq).toBe(7)
  })

  it('throws SaveConflictError with the parsed conflicts on a 409', async () => {
    const conflicts = [{ table: 'pages', rowId: 'page_home', seq: 12 }]
    const adapter = new CmsAdapter(async () =>
      new Response(JSON.stringify({ error: 'save conflict', conflicts }), { status: 409 }))

    const err = await adapter
      .saveSite(site(), { dirty: emptyDirty(), baseSeqs: {}, shellBaseSeq: 0 })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(SaveConflictError)
    expect((err as SaveConflictError).conflicts).toEqual([
      { table: 'pages', rowId: 'page_home', seq: 12 },
    ])
  })

  it('loadSite returns per-row seqs and the shell seq alongside the document', async () => {
    const adapter = new CmsAdapter(async (input) => {
      const url = String(input)
      if (url.endsWith('/site')) {
        return new Response(JSON.stringify({ site: site(), seq: 3 }), { status: 200 })
      }
      if (url.endsWith('/pages')) {
        return new Response(JSON.stringify({
          rows: [{
            id: 'page_home', tableId: 'pages', slug: 'index', status: 'draft', seq: 2,
            cells: { title: 'index', slug: 'index', body: { rootNodeId: 'root', nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [] } } } },
            authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
            author: null, createdBy: null, updatedBy: null, publishedBy: null,
            createdAt: '2026-01-01', updatedAt: '2026-01-01', publishedAt: null,
            scheduledPublishAt: null, deletedAt: null,
          }],
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    })

    const loaded = await adapter.loadSite('default')
    expect(loaded?.shellSeq).toBe(3)
    expect(loaded?.rowSeqs).toEqual({ page_home: 2 })
  })

  it('loadSiteRow fetches the single-row filter and returns null for a deleted row', async () => {
    const requested: string[] = []
    const adapter = new CmsAdapter(async (input) => {
      requested.push(String(input))
      return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    })

    const row = await adapter.loadSiteRow('pages', 'page-gone')
    expect(row).toBeNull()
    expect(requested[0]).toBe('/admin/api/cms/pages?id=page-gone')
  })
})
