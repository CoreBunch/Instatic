/**
 * Incremental roster saves: PUT /admin/api/cms/pages and PUT /admin/api/cms/components.
 *
 * The bodies carry `{ changedPages, pageIds, baselinePageIds? }` /
 * `{ changedComponents, componentIds }` — only the changed rows are validated
 * and written; the full id roster drives reaping with full-replace semantics
 * (subject to the ISS-041 baseline on the pages side).
 *
 * Runs against a real isolated SQLite DB through the established capability
 * harness (`createCapabilityTestHarness` → `createTestDb`): migrations applied,
 * owner user + stepped-up session seeded via the real setup/login endpoints,
 * requests dispatched through `handleCmsRequest`.
 */
import { describe, expect, it } from 'bun:test'
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

interface StoredRow {
  id: string
  slug: string
  cells_json: { title?: string } & Record<string, unknown>
  updated_at: string
  deleted_at: string | null
}

async function storedRows(harness: CapabilityTestHarness, tableId: string): Promise<Map<string, StoredRow>> {
  const { rows } = await harness.db<StoredRow>`
    select id, slug, cells_json, updated_at, deleted_at
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
}

async function setupHarness(): Promise<Ctx> {
  const harness = await createCapabilityTestHarness()
  const cookie = await harness.setupOwner()
  const pages = await storedRows(harness, 'pages')
  expect(pages.size).toBe(1)
  const homeId = [...pages.keys()][0]
  return { harness, cookie, homeId }
}

function putPages(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  return ctx.harness.cms('/admin/api/cms/pages', { method: 'PUT', cookie: ctx.cookie, json: body })
}

function putComponents(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  return ctx.harness.cms('/admin/api/cms/components', { method: 'PUT', cookie: ctx.cookie, json: body })
}

function putLayouts(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  return ctx.harness.cms('/admin/api/cms/layouts', { method: 'PUT', cookie: ctx.cookie, json: body })
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

async function expectOk(res: Response): Promise<void> {
  expect(res.status).toBe(200)
  expect(await readJson<{ ok?: boolean }>(res)).toEqual({ ok: true })
}

// ---------------------------------------------------------------------------
// PUT /admin/api/cms/pages
// ---------------------------------------------------------------------------

describe('PUT /admin/api/cms/pages — incremental roster save', () => {
  it('writes ONLY the changed page among N stored rows', async () => {
    const ctx = await setupHarness()
    try {
      // Store two extra pages so the table holds three rows.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
        pageIds: [ctx.homeId, 'page-a', 'page-b'],
      }))

      await backdateRows(ctx.harness, 'pages')
      const before = await storedRows(ctx.harness, 'pages')

      // Change ONLY page-a.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about', 'About v2')],
        pageIds: [ctx.homeId, 'page-a', 'page-b'],
      }))

      const after = await storedRows(ctx.harness, 'pages')

      // page-a: cells rewritten, updated_at bumped off the backdated value.
      expect(after.get('page-a')!.cells_json.title).toBe('About v2')
      expect(after.get('page-a')!.updated_at).not.toBe(BACKDATED)

      // The home page and page-b are untouched — identical cells AND the
      // backdated updated_at survives, proving no redundant write happened.
      for (const id of [ctx.homeId, 'page-b']) {
        expect(after.get(id)!.updated_at).toBe(BACKDATED)
        expect(after.get(id)!.cells_json).toEqual(before.get(id)!.cells_json)
      }
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a changed page whose id is missing from the pageIds roster', async () => {
    const ctx = await setupHarness()
    try {
      const res = await putPages(ctx, {
        changedPages: [pagePayload('page-orphan', 'orphan')],
        pageIds: [ctx.homeId], // page-orphan not in the roster
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('missing from pageIds roster')

      // Nothing was written.
      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.has('page-orphan')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('soft-deletes a row missing from the roster when the baseline contains it (ISS-041)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
        pageIds: [ctx.homeId, 'page-a'],
      }))

      // Client knew about page-a (baseline) and dropped it from the roster.
      await expectOk(await putPages(ctx, {
        changedPages: [],
        pageIds: [ctx.homeId],
        baselinePageIds: [ctx.homeId, 'page-a'],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.deleted_at).not.toBeNull()
      expect(rows.get(ctx.homeId)!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('preserves a row missing from the roster when the baseline does NOT contain it (sibling create)', async () => {
    const ctx = await setupHarness()
    try {
      // page-c simulates a sibling session's just-created page.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-c', 'pricing')],
        pageIds: [ctx.homeId, 'page-c'],
      }))

      // This client never loaded page-c: roster omits it, baseline omits it.
      await expectOk(await putPages(ctx, {
        changedPages: [],
        pageIds: [ctx.homeId],
        baselinePageIds: [ctx.homeId],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-c')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a slug conflict between a changed page and an UNCHANGED stored page', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
        pageIds: [ctx.homeId, 'page-a', 'page-b'],
      }))

      // page-a tries to take page-b's slug while page-b stays unchanged.
      const res = await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'contact')],
        pageIds: [ctx.homeId, 'page-a', 'page-b'],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error.toLowerCase()).toContain('duplicate')
      expect(body.error).toContain('slug')

      // page-a keeps its old slug in storage.
      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.slug).toBe('about')
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a changed batch may retake the slug of a row this same batch replaces (id-matched exclusion)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
        pageIds: [ctx.homeId, 'page-a'],
      }))

      // page-a itself changes title but keeps its own slug — its stored slug
      // must not count as a conflict against itself.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about', 'About again')],
        pageIds: [ctx.homeId, 'page-a'],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.cells_json.title).toBe('About again')
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('creates a row for a new page id present in changedPages + pageIds', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-new', 'team', 'Team')],
        pageIds: [ctx.homeId, 'page-new'],
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

  it('a changed page may take the slug of a row reaped in the same request (homepage swap + delete)', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
        pageIds: [ctx.homeId, 'page-a'],
      }))

      // The editor batch behind "set page-a as homepage, delete the old
      // homepage, save": page-a takes slug `index` while the row that still
      // holds it is reaped by this same request.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'index')],
        pageIds: ['page-a'],
        baselinePageIds: [ctx.homeId, 'page-a'],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.slug).toBe('index')
      expect(rows.get('page-a')!.deleted_at).toBeNull()
      expect(rows.get(ctx.homeId)!.deleted_at).not.toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a new page may take the slug of a row reaped in the same request', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-fresh', 'index', 'New homepage')],
        pageIds: ['page-fresh'],
        baselinePageIds: [ctx.homeId],
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
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about')],
        pageIds: [ctx.homeId, 'page-a'],
      }))
      // Delete page-a and save.
      await expectOk(await putPages(ctx, {
        changedPages: [],
        pageIds: [ctx.homeId],
        baselinePageIds: [ctx.homeId, 'page-a'],
      }))
      // Undo restores the page object with its ORIGINAL id; the next save
      // ships it as a changed page again. The reaped row must be revived,
      // not collide with its own soft-deleted primary key.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about', 'About restored')],
        pageIds: [ctx.homeId, 'page-a'],
        baselinePageIds: [ctx.homeId],
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
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'about'), pagePayload('page-b', 'contact')],
        pageIds: [ctx.homeId, 'page-a', 'page-b'],
      }))

      // True swap — no in-place update order avoids a transient collision
      // with data_rows_table_slug_active_idx, so this exercises the
      // placeholder pass. Collision-maximizing order: each page's target
      // slug is still held by the other.
      await expectOk(await putPages(ctx, {
        changedPages: [pagePayload('page-a', 'contact'), pagePayload('page-b', 'about')],
        pageIds: [ctx.homeId, 'page-a', 'page-b'],
        baselinePageIds: [ctx.homeId, 'page-a', 'page-b'],
      }))

      const rows = await storedRows(ctx.harness, 'pages')
      expect(rows.get('page-a')!.slug).toBe('contact')
      expect(rows.get('page-b')!.slug).toBe('about')
      // The placeholder slug '' must never survive the reconcile.
      for (const row of rows.values()) expect(row.slug).not.toBe('')
    } finally {
      await ctx.harness.cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// PUT /admin/api/cms/components
// ---------------------------------------------------------------------------

describe('PUT /admin/api/cms/components — incremental roster save', () => {
  it('keeps a changed VC valid when it references an UNCHANGED stored VC', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base'), vcPayload('vc-ref', 'RefCard', 'vc-base')],
        componentIds: ['vc-base', 'vc-ref'],
      }))

      await backdateRows(ctx.harness, 'components')

      // Only vc-ref changes; its ref target vc-base rides along unchanged in
      // the merged validation roster.
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-ref', 'RefCard v2', 'vc-base')],
        componentIds: ['vc-base', 'vc-ref'],
      }))

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-ref')!.updated_at).not.toBe(BACKDATED)
      expect((rows.get('vc-ref')!.cells_json as { name?: string }).name).toBe('RefCard v2')
      // The unchanged ref target was not rewritten.
      expect(rows.get('vc-base')!.updated_at).toBe(BACKDATED)
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a changed VC referencing an id absent from the componentIds roster', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base')],
        componentIds: ['vc-base'],
      }))

      // vc-ref points at vc-base, but the roster drops vc-base — the merged
      // post-save roster would not contain the ref target.
      const res = await putComponents(ctx, {
        changedComponents: [vcPayload('vc-ref', 'RefCard', 'vc-base')],
        componentIds: ['vc-ref'],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('references missing Visual Component')

      // Neither the write nor the reap happened — vc-base survives untouched.
      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
      expect(rows.has('vc-ref')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects deleting a VC that an UNCHANGED stored VC still references', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base'), vcPayload('vc-ref', 'RefCard', 'vc-base')],
        componentIds: ['vc-base', 'vc-ref'],
      }))

      // Drop vc-base from the roster while the unchanged vc-ref still points
      // at it. validateVisualComponentsForPartialWrite merges the kept stored
      // roster (vc-ref) over keptIds and runs validateStrictVCRefs — the
      // dangling ref through the UNCHANGED component must reject the save.
      const res = await putComponents(ctx, {
        changedComponents: [],
        componentIds: ['vc-ref'],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('references missing Visual Component')

      // The reap was rejected wholesale — vc-base is still live.
      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
      expect(rows.get('vc-ref')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('soft-deletes an unreferenced VC missing from the componentIds roster', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-base', 'Base'), vcPayload('vc-lone', 'Standalone')],
        componentIds: ['vc-base', 'vc-lone'],
      }))

      await expectOk(await putComponents(ctx, {
        changedComponents: [],
        componentIds: ['vc-base'],
      }))

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.get('vc-lone')!.deleted_at).not.toBeNull()
      expect(rows.get('vc-base')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects a changed component whose id is missing from the componentIds roster', async () => {
    const ctx = await setupHarness()
    try {
      const res = await putComponents(ctx, {
        changedComponents: [vcPayload('vc-orphan', 'Orphan')],
        componentIds: [],
      })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string }>(res)
      expect(body.error).toContain('missing from componentIds roster')

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.has('vc-orphan')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('rejects two VCs whose distinct names derive the same storage slug', async () => {
    const ctx = await setupHarness()
    try {
      // 'Button' and 'button' are distinct strings but identical slugs —
      // without a validation reject this dies on the DB unique index as a 500.
      const res = await putComponents(ctx, {
        changedComponents: [vcPayload('vc-a', 'Button'), vcPayload('vc-b', 'button')],
        componentIds: ['vc-a', 'vc-b'],
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
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-a', 'Button')],
        componentIds: ['vc-a'],
      }))

      const res = await putComponents(ctx, {
        changedComponents: [vcPayload('vc-b', 'button')],
        componentIds: ['vc-a', 'vc-b'],
      })
      expect(res.status).toBe(400)

      const rows = await storedRows(ctx.harness, 'components')
      expect(rows.has('vc-b')).toBe(false)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a created VC may reuse the name (and slug) of a VC reaped in the same request', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-old', 'Button')],
        componentIds: ['vc-old'],
      }))

      // Delete "Button" and create a fresh VC with the same name in one save —
      // both rows derive the slug `button`, so the reap must free it before
      // the create runs.
      await expectOk(await putComponents(ctx, {
        changedComponents: [vcPayload('vc-new', 'Button')],
        componentIds: ['vc-new'],
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
// PUT /admin/api/cms/layouts
// ---------------------------------------------------------------------------

describe('PUT /admin/api/cms/layouts — incremental roster save', () => {
  it('rejects two layouts whose distinct names derive the same storage slug', async () => {
    const ctx = await setupHarness()
    try {
      // 'Hero!' and 'Hero?' both slug to 'hero' — must reject as a 400, not
      // die on the DB unique index as a 500.
      const res = await putLayouts(ctx, {
        changedLayouts: [layoutPayload('lay-a', 'Hero!'), layoutPayload('lay-b', 'Hero?')],
        layoutIds: ['lay-a', 'lay-b'],
      })
      expect(res.status).toBe(400)

      const rows = await storedRows(ctx.harness, 'layouts')
      expect(rows.size).toBe(0)
    } finally {
      await ctx.harness.cleanup()
    }
  })

  it('a created layout may reuse the name of a layout reaped in the same request', async () => {
    const ctx = await setupHarness()
    try {
      await expectOk(await putLayouts(ctx, {
        changedLayouts: [layoutPayload('lay-old', 'Hero')],
        layoutIds: ['lay-old'],
      }))

      await expectOk(await putLayouts(ctx, {
        changedLayouts: [layoutPayload('lay-new', 'Hero')],
        layoutIds: ['lay-new'],
      }))

      const rows = await storedRows(ctx.harness, 'layouts')
      expect(rows.get('lay-old')!.deleted_at).not.toBeNull()
      expect(rows.get('lay-new')!.deleted_at).toBeNull()
    } finally {
      await ctx.harness.cleanup()
    }
  })
})
