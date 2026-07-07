/**
 * PUT /admin/api/cms/site-document — the transactional whole-document save.
 *
 * One body carries the shell plus per-collection changed rows and explicit
 * deleted ids:
 *
 *   { mode, site, changedPages, deletedPageIds,
 *     changedComponents, deletedComponentIds,
 *     changedLayouts, deletedLayoutIds }
 *
 * Covered here:
 *   - O(change) writes: unmentioned rows are byte-untouched (no reap-by-
 *     omission — a stale client cannot delete anything it doesn't name),
 *   - explicit deletes (including delete + retake-slug in one batch, undo
 *     resurrection, two-phase slug swaps),
 *   - ATOMICITY: one invalid item rejects the whole save — shell and valid
 *     sibling collections are not persisted,
 *   - cross-collection validation: pages validate VC refs against the MERGED
 *     post-save component roster (a page may reference a component created
 *     in the SAME save),
 *   - replace mode (imports): server-derived deletions, deleted*Ids must be
 *     empty,
 *   - the site-global sync seq: response seq strictly increases and is
 *     stamped on written AND deleted rows.
 *
 * Runs against a real isolated SQLite DB through the established capability
 * harness (`createCapabilityTestHarness` → `createTestDb`): migrations
 * applied, owner user + stepped-up session seeded via the real setup/login
 * endpoints, requests dispatched through `handleCmsRequest`.
 */
import { describe, expect, it } from 'bun:test'
import type { SiteShell } from '@core/page-tree'
import {
  createCapabilityTestHarness,
  readJson,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

// ---------------------------------------------------------------------------
// Payload + DB helpers
// ---------------------------------------------------------------------------

const BACKDATED = '2000-01-01 00:00:00'

function pagePayload(id: string, slug: string, title = slug): Record<string, unknown> {
  const rootId = `root-${id}`
  return {
    id,
    slug,
    title,
    rootNodeId: rootId,
    nodes: {
      [rootId]: {
        id: rootId,
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: [],
      },
    },
  }
}

/** A page whose body contains a base.visual-component-ref to `componentId`. */
function pageWithVCRef(id: string, slug: string, componentId: string): Record<string, unknown> {
  const rootId = `root-${id}`
  const refId = `ref-${id}`
  return {
    id,
    slug,
    title: slug,
    rootNodeId: rootId,
    nodes: {
      [rootId]: {
        id: rootId,
        moduleId: 'base.body',
        props: {},
        breakpointOverrides: {},
        children: [refId],
      },
      [refId]: {
        id: refId,
        moduleId: 'base.visual-component-ref',
        props: { componentId },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
  }
}

function vcNode(id: string, moduleId: string, children: string[] = [], props: Record<string, unknown> = {}) {
  return { id, moduleId, props, breakpointOverrides: {}, children, classIds: [] }
}

/** A minimal VC; pass `refTo` to embed a base.visual-component-ref child. */
function vcPayload(id: string, name: string, refTo?: string): Record<string, unknown> {
  const rootId = `root-${id}`
  const nodes: Record<string, unknown> = refTo
    ? {
        [rootId]: vcNode(rootId, 'base.container', [`ref-${id}`]),
        [`ref-${id}`]: vcNode(`ref-${id}`, 'base.visual-component-ref', [], { componentId: refTo }),
      }
    : { [rootId]: vcNode(rootId, 'base.container') }
  return {
    id,
    name,
    tree: { rootNodeId: rootId, nodes },
    params: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
  }
}

/** A minimal saved layout — one container node, no captured classes. */
function layoutPayload(id: string, name: string): Record<string, unknown> {
  const rootId = `root-${id}`
  return {
    id,
    name,
    rootNodeId: rootId,
    nodes: { [rootId]: vcNode(rootId, 'base.container') },
    classes: {},
    createdAt: 1_700_000_000_000,
  }
}

interface StoredRow {
  id: string
  slug: string
  cells_json: { title?: string } & Record<string, unknown>
  seq: number
  updated_at: string
  deleted_at: string | null
}

async function storedRows(harness: CapabilityTestHarness, tableId: string): Promise<Map<string, StoredRow>> {
  const { rows } = await harness.db<StoredRow>`
    select id, slug, cells_json, seq, updated_at, deleted_at
    from data_rows
    where table_id = ${tableId}
  `
  return new Map(rows.map((row) => [row.id, row]))
}

async function backdateRows(harness: CapabilityTestHarness, tableId: string): Promise<void> {
  await harness.db`
    update data_rows set updated_at = ${BACKDATED} where table_id = ${tableId}
  `
}

interface Ctx {
  harness: CapabilityTestHarness
  cookie: string
  /** Id of the home page row the setup endpoint seeds (slug `index`). */
  homeId: string
  /** The draft shell as stored — re-shipped verbatim on every save. */
  shell: SiteShell
}

async function setupHarness(): Promise<Ctx> {
  const harness = await createCapabilityTestHarness()
  const cookie = await harness.setupOwner()
  const pages = await storedRows(harness, 'pages')
  expect(pages.size).toBe(1)
  const homeId = [...pages.keys()][0]
  const shellRes = await harness.cms('/admin/api/cms/site', { method: 'GET', cookie })
  expect(shellRes.status).toBe(200)
  const { site: shell } = await readJson<{ site: SiteShell }>(shellRes)
  return { harness, cookie, homeId, shell }
}

interface DocOverrides {
  mode?: 'incremental' | 'replace'
  site?: unknown
  changedPages?: unknown[]
  deletedPageIds?: string[]
  changedComponents?: unknown[]
  deletedComponentIds?: string[]
  changedLayouts?: unknown[]
  deletedLayoutIds?: string[]
}

function putDoc(ctx: Ctx, overrides: DocOverrides = {}): Promise<Response> {
  return ctx.harness.cms('/admin/api/cms/site-document', {
    method: 'PUT',
    cookie: ctx.cookie,
    json: {
      mode: 'incremental',
      site: ctx.shell,
      changedPages: [],
      deletedPageIds: [],
      changedComponents: [],
      deletedComponentIds: [],
      changedLayouts: [],
      deletedLayoutIds: [],
      ...overrides,
    },
  })
}

async function expectOk(res: Response): Promise<number> {
  expect(res.status).toBe(200)
  const body = await readJson<{ ok?: boolean; seq?: number }>(res)
  expect(body.ok).toBe(true)
  expect(typeof body.seq).toBe('number')
  return body.seq!
}

// ---------------------------------------------------------------------------
// Pages — O(change) writes + explicit deletes
// ---------------------------------------------------------------------------

describe('site-document save — pages', () => {
  it('writes ONLY the changed page among N stored rows; unmentioned rows are byte-untouched', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
      }))

      await backdateRows(ctx.harness, 'pages')
      const before = await storedRows(ctx.harness, 'pages')

      // Change ONLY page-a. No rosters exist — page-b and the home page are
      // simply not mentioned, so they cannot be touched (or deleted).
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about', 'About v2')],
      }))

      const after = await storedRows(ctx.harness, 'pages')
      expect(after.get('page-a')!.cells_json.title).toBe('About v2')
      expect(after.get('page-a')!.updated_at).not.toBe(BACKDATED)

      for (const id of [ctx.homeId, 'page-b']) {
        expect(after.get(id)!.updated_at).toBe(BACKDATED)
        expect(after.get(id)!.cells_json).toEqual(before.get(id)!.cells_json)
        expect(after.get(id)!.deleted_at).toBeNull()
      }
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('soft-deletes exactly the explicitly named ids', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
      }))

      await expectOk(await putDoc(ctx, { deletedPageIds: ['page-a'] }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.deleted_at).not.toBeNull()
      expect(rows.get(ctx.homeId)!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a page id present in BOTH changedPages and deletedPageIds', async () => {
    const ctx = await setupHarness()
    try {
      const res = await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
        deletedPageIds: ['page-a'],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('both changed and deleted')

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.has('page-a')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a slug conflict between a changed page and an UNCHANGED stored page', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
      }))

      // page-a tries to take page-b's slug while page-b stays unchanged.
      const res = await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'contact')],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error.toLowerCase()).toContain('duplicate')
      expect(body.error).toContain('slug')

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.slug).toBe('about')
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a changed batch may retake the slug of a row this same batch replaces (id-matched exclusion)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
      }))

      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about', 'About again')],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.cells_json.title).toBe('About again')
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('creates a row for a new page id in changedPages', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-new', 'team', 'Team')],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      const created = rows.get('page-new')
      expect(created).toBeDefined()
      expect(created!.slug).toBe('team')
      expect(created!.cells_json.title).toBe('Team')
      expect(created!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a changed page may take the slug of a row deleted in the same request (homepage swap + delete)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
      }))

      // The editor batch behind "set page-a as homepage, delete the old
      // homepage, save": page-a takes slug `index` while the row that still
      // holds it is deleted by this same request.
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'index')],
        deletedPageIds: [ctx.homeId],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.slug).toBe('index')
      expect(rows.get('page-a')!.deleted_at).toBeNull()
      expect(rows.get(ctx.homeId)!.deleted_at).not.toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a new page may take the slug of a row deleted in the same request', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-fresh', 'index', 'New homepage')],
        deletedPageIds: [ctx.homeId],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-fresh')!.slug).toBe('index')
      expect(rows.get(ctx.homeId)!.deleted_at).not.toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('restores a page deleted by an earlier save when the same id is re-submitted (undo of a delete)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
      }))
      await expectOk(await putDoc(ctx, { deletedPageIds: ['page-a'] }))

      // Undo restores the page object with its ORIGINAL id; the next save
      // ships it as a changed page again. The soft-deleted row must be
      // revived, not collide with its own primary key.
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about', 'About restored')],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.deleted_at).toBeNull()
      expect(rows.get('page-a')!.slug).toBe('about')
      expect(rows.get('page-a')!.cells_json.title).toBe('About restored')
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('two changed pages may swap slugs in one batch (two-phase write)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
      }))

      // True swap — no in-place update order avoids a transient collision
      // with data_rows_table_slug_active_idx, so this exercises the
      // placeholder pass.
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'contact'), pagePayload('page-b', 'about')],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.slug).toBe('contact')
      expect(rows.get('page-b')!.slug).toBe('about')
      // The placeholder slug '' must never survive the save.
      for (const row of rows.values()) expect(row.slug).not.toBe('')
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Atomicity — one invalid item rejects the WHOLE save
// ---------------------------------------------------------------------------

describe('site-document save — atomicity', () => {
  it('an invalid page rejects the batch: shell and valid components are NOT persisted', async () => {
    const ctx = await setupHarness()
    try {
      const editedShell = structuredClone(ctx.shell) as SiteShell
      editedShell.settings.metaTitle = 'Should never persist'

      const res = await putDoc(ctx, {
        site: editedShell,
        changedComponents: [vcPayload('vc-valid', 'Valid Component')],
        // Duplicate of the seeded home slug — validation must reject.
        changedPages: [pagePayload('page-bad', 'index')],
      })
      expect(res.status).toBe(400)

      // The valid component was NOT written…
      const components = await storedRows(ctx.harness, 'components')
      expect(components.has('vc-valid')).toBe(false)

      // …and the shell change was NOT written either.
      const shellRes = await ctx.harness.cms('/admin/api/cms/site', { method: 'GET', cookie: ctx.cookie })
      const { site: storedShell } = await readJson<{ site: SiteShell }>(shellRes)
      expect(storedShell.settings.metaTitle).not.toBe('Should never persist')
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Components — merged-roster validation + explicit deletes
// ---------------------------------------------------------------------------

describe('site-document save — components', () => {
  it('keeps a changed VC valid when it references an UNCHANGED stored VC', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base'), vcPayload('vc-ref', 'RefCard', 'vc-base')],
      }))

      await backdateRows(ctx.harness, 'components')

      // Only vc-ref changes; its ref target vc-base rides along unchanged in
      // the merged validation roster.
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-ref', 'RefCard v2', 'vc-base')],
      }))

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-ref')!.updated_at).not.toBe(BACKDATED)
      expect((rows.get('vc-ref')!.cells_json as { name?: string }).name).toBe('RefCard v2')
      expect(rows.get('vc-base')!.updated_at).toBe(BACKDATED)
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a changed VC referencing a component id that does not exist', async () => {
    const ctx = await setupHarness()
    try {
      const res = await putDoc(ctx, {
        changedComponents: [vcPayload('vc-ref', 'RefCard', 'vc-never-existed')],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('references missing Visual Component')

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.has('vc-ref')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects deleting a VC that an UNCHANGED stored VC still references', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base'), vcPayload('vc-ref', 'RefCard', 'vc-base')],
      }))

      // Delete vc-base while the unchanged vc-ref still points at it — the
      // merged post-save roster validation must reject the dangling ref.
      const res = await putDoc(ctx, { deletedComponentIds: ['vc-base'] })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('references missing Visual Component')

      // The delete was rejected wholesale — vc-base is still live.
      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
      expect(rows.get('vc-ref')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('soft-deletes an unreferenced VC named in deletedComponentIds', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base'), vcPayload('vc-lone', 'Standalone')],
      }))

      await expectOk(await putDoc(ctx, { deletedComponentIds: ['vc-lone'] }))

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-lone')!.deleted_at).not.toBeNull()
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a page may reference a component CREATED in the same save (merged-roster validation)', async () => {
    const ctx = await setupHarness()
    try {
      // Old protocol: the client had to commit components before pages or the
      // server stripped the ref as dangling. Now both land in one transaction
      // and pages validate against the merged post-save roster.
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-fresh', 'Fresh Component')],
        changedPages: [pageWithVCRef('page-ref', 'with-ref', 'vc-fresh')],
      }))

      const pages = await storedRows(ctx.harness, 'pages')
      const stored = pages.get('page-ref')!
      // Page trees persist in cells.body as { nodes, rootNodeId } (pageFromRow).
      const nodes = (stored.cells_json as { body?: { nodes?: Record<string, { moduleId?: string; props?: { componentId?: string } }> } }).body?.nodes ?? {}
      const refNode = Object.values(nodes).find((n) => n.moduleId === 'base.visual-component-ref')
      expect(refNode).toBeDefined()
      expect(refNode!.props?.componentId).toBe('vc-fresh')
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects two VCs whose distinct names derive the same storage slug', async () => {
    const ctx = await setupHarness()
    try {
      const res = await putDoc(ctx, {
        changedComponents: [vcPayload('vc-a', 'Button'), vcPayload('vc-b', 'button')],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('Button')

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.size).toBe(0)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a changed VC whose name slug-collides with a kept stored VC', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-a', 'Button')],
      }))

      const res = await putDoc(ctx, {
        changedComponents: [vcPayload('vc-b', 'button')],
      })
      expect(res.status).toBe(400)

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.has('vc-b')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a created VC may reuse the name (and slug) of a VC deleted in the same request', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-old', 'Button')],
      }))

      // Delete "Button" and create a fresh VC with the same name in one save —
      // both rows derive the slug `button`, so the delete must free it before
      // the create runs.
      await expectOk(await putDoc(ctx, {
        changedComponents: [vcPayload('vc-new', 'Button')],
        deletedComponentIds: ['vc-old'],
      }))

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-old')!.deleted_at).not.toBeNull()
      expect(rows.get('vc-new')!.deleted_at).toBeNull()
      expect(rows.get('vc-new')!.slug).toBe(rows.get('vc-old')!.slug)
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

describe('site-document save — layouts', () => {
  it('rejects two layouts whose distinct names derive the same storage slug', async () => {
    const ctx = await setupHarness()
    try {
      // 'Hero!' and 'Hero?' both slug to 'hero' — must reject as a 400, not
      // die on the DB unique index as a 500.
      const res = await putDoc(ctx, {
        changedLayouts: [layoutPayload('lay-a', 'Hero!'), layoutPayload('lay-b', 'Hero?')],
      })
      expect(res.status).toBe(400)

      const rows = await storedRows(ctx.harness, 'layouts')
      expect(rows.size).toBe(0)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a created layout may reuse the name of a layout deleted in the same request', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedLayouts: [layoutPayload('lay-old', 'Hero')],
      }))

      await expectOk(await putDoc(ctx, {
        changedLayouts: [layoutPayload('lay-new', 'Hero')],
        deletedLayoutIds: ['lay-old'],
      }))

      const rows = await storedRows(ctx.harness, 'layouts')
      expect(rows.get('lay-old')!.deleted_at).not.toBeNull()
      expect(rows.get('lay-new')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Replace mode (imports)
// ---------------------------------------------------------------------------

describe('site-document save — replace mode', () => {
  it('derives deletions as stored − shipped', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
      }))

      // Replace with home + page-a only → page-b is reaped server-side.
      const homeRows = await storedRows(ctx.harness, 'pages')
      const home = homeRows.get(ctx.homeId)!
      const homePayload = pagePayload(ctx.homeId, home.slug, home.cells_json.title ?? 'Home')
      await expectOk(await putDoc(ctx, {
        mode: 'replace',
        changedPages: [homePayload, pagePayload('page-a', 'about')],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-b')!.deleted_at).not.toBeNull()
      expect(rows.get('page-a')!.deleted_at).toBeNull()
      expect(rows.get(ctx.homeId)!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects non-empty deleted*Ids in replace mode', async () => {
    const ctx = await setupHarness()
    try {
      const res = await putDoc(ctx, {
        mode: 'replace',
        deletedPageIds: ['anything'],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('replace mode')
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// Sync sequence
// ---------------------------------------------------------------------------

describe('site-document save — sync seq', () => {
  it('returns a strictly increasing seq and stamps written AND deleted rows', async () => {
    const ctx = await setupHarness()
    try {
      const first = await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
      }))
      const second = await expectOk(await putDoc(ctx, {
        changedPages: [pagePayload('page-b', 'contact')],
        deletedPageIds: ['page-a'],
      }))
      expect(second).toBeGreaterThan(first)

      const rows = await storedRows(ctx.harness, 'pages')
      // page-b written by save #2, page-a deleted by save #2 — both stamped.
      expect(rows.get('page-b')!.seq).toBe(second)
      expect(rows.get('page-a')!.seq).toBe(second)
      // The home page was never written after seeding — seq untouched (0 or
      // whatever the seed left), definitely below save #1's seq.
      expect(rows.get(ctx.homeId)!.seq).toBeLessThan(first)
    } finally {
      await ctx.harness.cleanup()
    }
  })
})
