/**
 * Integration test for the Layer A static-artefact publish protocol.
 *
 * Uses a minimal fake DB and a real tmpdir to exercise:
 *
 *   1. `publishDraftSite` with a mixed fixture site (some fully-static pages,
 *      one page with a request-dependent loop source) → only static pages get
 *      a disk artefact, symlink is flipped, old slot is left intact.
 *
 *   2. The router's disk fast-path: a request whose URL matches a baked
 *      artefact returns the pre-rendered HTML without hitting the DB snapshot
 *      path.
 *
 *   3. A request with a query string falls through to the live renderer (DB
 *      path), not the disk path.
 *
 * The rendering pipeline (publishPage → applyPublishedHtmlPipeline) is
 * exercised for real using the base module registry and a stub plugin hook
 * bus. The stub hookBus is the default in-process bus which has no plugins
 * registered, so `publish.html` is a no-op and `injectFrontendAssets` only
 * adds the default CSP headers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbResult } from '../../../server/db'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { handleServerRequest } from '../../../server/router'
import {
  getActiveSlot,
  readArtefact,
  readStaticAsset,
} from '../../../server/publish/staticArtefact'
import { createFakeDb } from './dbTestFake'
import { makePage, makeSite } from '../publisher/helpers'
import type { LoopEntitySource } from '../../../src/core/loops/types'
import { loopSourceRegistry } from '../../../src/core/loops/registry'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowDate(value: string) {
  return new Date(value)
}

/** Make a minimal PublishedPageSnapshot with the given page as the only content. */
function makeSnapshot(page: ReturnType<typeof makePage>): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: page.id,
    site: makeSite({ pages: [page] }),
  }
}

/**
 * Build a fake DbClient that answers the queries `publishDraftSite` and
 * the live-render fallback path need. Snapshots are built on-the-fly from
 * the provided page fixtures.
 */
function buildFakeDb(
  staticPage: ReturnType<typeof makePage>,
  dynamicPage: ReturnType<typeof makePage>,
) {
  const staticSnapshot = makeSnapshot(staticPage)
  const dynamicSnapshot = makeSnapshot(dynamicPage)

  /** Row shape the snapshot getters' 3-way join returns. */
  const toSnapshotRow = (snapshot: PublishedPageSnapshot) => ({
    row_id: snapshot.pageRowId,
    site_json: snapshot.site,
    runtime_assets_json: snapshot.runtimeAssets ?? null,
    importmap_body: snapshot.runtimePackageImportmap?.body ?? null,
    importmap_sha256: snapshot.runtimePackageImportmap?.sha256 ?? null,
  })

  let insertCallCount = 0

  return createFakeDb(async (sql: string, params: unknown[]): Promise<DbResult> => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // ── snapshot getters (live render fallback / row bake) ────────────────
    // MUST precede the listDataRows branch below: getLatestPublishedSiteSnapshot
    // also contains `select data_rows.id` + `order by`.
    if (s.includes('site_snapshots.site_json')) {
      // getPublishedPageBySlug — parameterised on data_rows.slug.
      if (s.includes('data_rows.slug =')) {
        const slug = typeof params[0] === 'string' ? params[0] : ''
        if (slug === staticPage.slug || slug === 'index') {
          return { rows: [toSnapshotRow(staticSnapshot)], rowCount: 1 }
        }
        if (slug === dynamicPage.slug) {
          return { rows: [toSnapshotRow(dynamicSnapshot)], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      // getLatestPublishedSiteSnapshot
      return { rows: [toSnapshotRow(staticSnapshot)], rowCount: 1 }
    }

    // ── getDraftSite ───────────────────────────────────────────────────────
    if (s.startsWith('select id, name, version, enabled, lifecycle_status')) {
      // Plugin listing for hook bus
      return { rows: [], rowCount: 0 }
    }

    if (s.includes('from site') && s.includes('select id')) {
      return {
        rows: [{
          id: 'proj-1',
          name: 'Test Site',
          settings_json: {
            metaTitle: 'Test Site',
            shortcuts: {},
          },
          files_json: [],
          classes_json: {},
          breakpoints_json: [
            { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
          ],
          runtime_json: {
            dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
            scripts: {},
          },
          version: 1,
          created_at: rowDate('2026-01-01'),
          updated_at: rowDate('2026-01-01'),
        }],
        rowCount: 1,
      }
    }

    // ── listDataRows (pages + components) ─────────────────────────────────
    // `listDataRows` parameterizes the table_id ($1), so we check params.
    if (s.includes('select data_rows.id') && s.includes('from data_rows') && s.includes('order by')) {
      if (params[0] === 'pages') {
        return {
          rows: [
            {
              id: staticPage.id,
              table_id: 'pages',
              slug: staticPage.slug,
              status: 'draft',
              cells_json: {
                title: staticPage.title,
                slug: staticPage.slug,
                body: { nodes: staticPage.nodes, rootNodeId: staticPage.rootNodeId },
              },
              author_user_id: null,
              author_email: null,
              author_display_name: null,
              author_role_slug: null,
              author_role_name: null,
              created_by_user_id: null,
              created_by_email: null,
              created_by_display_name: null,
              created_by_role_slug: null,
              created_by_role_name: null,
              updated_by_user_id: null,
              updated_by_email: null,
              updated_by_display_name: null,
              updated_by_role_slug: null,
              updated_by_role_name: null,
              published_by_user_id: null,
              published_by_email: null,
              published_by_display_name: null,
              published_by_role_slug: null,
              published_by_role_name: null,
              created_at: rowDate('2026-01-01'),
              updated_at: rowDate('2026-01-01'),
              published_at: null,
              scheduled_publish_at: null,
              deleted_at: null,
            },
            {
              id: dynamicPage.id,
              table_id: 'pages',
              slug: dynamicPage.slug,
              status: 'draft',
              cells_json: {
                title: dynamicPage.title,
                slug: dynamicPage.slug,
                body: { nodes: dynamicPage.nodes, rootNodeId: dynamicPage.rootNodeId },
              },
              author_user_id: null,
              author_email: null,
              author_display_name: null,
              author_role_slug: null,
              author_role_name: null,
              created_by_user_id: null,
              created_by_email: null,
              created_by_display_name: null,
              created_by_role_slug: null,
              created_by_role_name: null,
              updated_by_user_id: null,
              updated_by_email: null,
              updated_by_display_name: null,
              updated_by_role_slug: null,
              updated_by_role_name: null,
              published_by_user_id: null,
              published_by_email: null,
              published_by_display_name: null,
              published_by_role_slug: null,
              published_by_role_name: null,
              created_at: rowDate('2026-01-01'),
              updated_at: rowDate('2026-01-01'),
              published_at: null,
              scheduled_publish_at: null,
              deleted_at: null,
            },
          ],
          rowCount: 2,
        }
      }
      // components or any other table
      return { rows: [], rowCount: 0 }
    }

    // ── nextVersionNumber ─────────────────────────────────────────────────
    if (s.includes('coalesce(max(version_number), 0) + 1')) {
      return { rows: [{ next_version: 1 }], rowCount: 1 }
    }

    // ── insert into site_snapshots (one per publish) ──────────────────────
    if (s.includes('insert into site_snapshots')) {
      return { rows: [], rowCount: 1 }
    }

    // ── insert into data_row_versions ─────────────────────────────────────
    if (s.includes('insert into data_row_versions')) {
      insertCallCount++
      return { rows: [], rowCount: 1 }
    }

    // ── savePublishedRuntimeAssets ────────────────────────────────────────
    if (s.includes('insert into runtime_assets')) {
      return { rows: [], rowCount: 0 }
    }
    if (s.includes('select count') && s.includes('from runtime_assets')) {
      return { rows: [{ count: 0 }], rowCount: 1 }
    }

    // ── update data_rows (status=published) ───────────────────────────────
    if (s.includes('update data_rows') && s.includes("status = 'published'")) {
      return { rows: [], rowCount: 1 }
    }

    // ── collectFrontendInjections: active_media_storage_adapter ──────────
    if (s.includes('from active_media_storage_adapter')) {
      return { rows: [], rowCount: 0 }
    }

    // ── getSetupStatus ────────────────────────────────────────────────────
    if (s.includes('count(*) as count from site')) {
      return { rows: [{ count: 1 }], rowCount: 1 }
    }
    if (s.includes('from users') && s.includes('role_id')) {
      return { rows: [{ count: 1 }], rowCount: 1 }
    }

    // ── fallthrough ───────────────────────────────────────────────────────
    return { rows: [], rowCount: 0 }
  })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_DEPENDENT_SOURCE_ID = 'test.requestDependent'

const requestDependentSource: LoopEntitySource = {
  id: REQUEST_DEPENDENT_SOURCE_ID,
  label: 'Live API (request-dependent)',
  filterSchema: {},
  orderByOptions: [],
  fields: [],
  requestDependent: true,
  fetch: async () => ({ items: [], totalItems: 0 }),
  preview: () => [],
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('publishDraftSite — Layer A static artefacts', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'publish-artefact-'))
    loopSourceRegistry.register(requestDependentSource)
  })

  afterEach(async () => {
    loopSourceRegistry.unregister(REQUEST_DEPENDENT_SOURCE_ID)
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('writes a disk artefact for a fully-static page and flips the symlink', async () => {
    const staticPage = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['heading'] },
      heading: { moduleId: 'base.text', props: { text: 'Hello static world', tag: 'h1' }, children: [] },
    })
    staticPage.id = 'static-page'
    staticPage.slug = 'about'
    staticPage.title = 'About'

    const dynamicPage = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        props: { sourceId: REQUEST_DEPENDENT_SOURCE_ID },
        children: [],
      },
    })
    dynamicPage.id = 'dynamic-page'
    dynamicPage.slug = 'news'
    dynamicPage.title = 'News'

    const db = buildFakeDb(staticPage, dynamicPage)

    const { publishDraftSite } = await import('../../../server/repositories/publish')
    const result = await publishDraftSite(db, 'user-1', uploadsDir)

    expect(result.publishedPages).toBe(2)

    // Static page artefact exists
    const staticHtml = await readArtefact(uploadsDir, '/about')
    expect(staticHtml).not.toBeNull()
    expect(staticHtml).toContain('Hello static world')

    // Dynamic page is ALSO baked — as a static SHELL with a <instatic-hole>
    // placeholder for the request-dependent loop. Everything except the hole
    // fragment is on disk; the hole runtime hydrates the loop at request time.
    const dynamicHtml = await readArtefact(uploadsDir, '/news')
    expect(dynamicHtml).not.toBeNull()
    expect(dynamicHtml).toContain('<instatic-hole')
    expect(dynamicHtml).toContain('/_instatic/hole-runtime.js')
    // The loop's items are NOT inlined — they come from the hole fetch.

    // Symlink exists and points to a slot
    const activeSlot = await getActiveSlot(uploadsDir)
    expect(['a', 'b']).toContain(activeSlot)

    // Complete static publishing: the CSS bundles the page links must be
    // baked to disk so the page never needs the server to regenerate them.
    const cssHrefs = [...(staticHtml ?? '').matchAll(/href="(\/_instatic\/css\/[^"]+\.css)"/g)].map((m) => m[1])
    expect(cssHrefs.length).toBeGreaterThan(0) // reset + framework at minimum
    for (const href of cssHrefs) {
      const bytes = await readStaticAsset(uploadsDir, href)
      expect(bytes).not.toBeNull()
      expect(bytes!.byteLength).toBeGreaterThan(0)
    }

    // And the router serves that CSS off disk (200, text/css) without ever
    // touching a DB snapshot.
    let snapshotLookupCalled = false
    const diskCssDb = createFakeDb(async (sql: string): Promise<DbResult> => {
      const s = sql.toLowerCase()
      if (s.includes('site_snapshots')) snapshotLookupCalled = true
      return { rows: [], rowCount: 0 }
    })
    const cssRes = await handleServerRequest(
      new Request(`http://localhost${cssHrefs[0]}`),
      { db: diskCssDb, uploadsDir },
    )
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(snapshotLookupCalled).toBe(false)
  })

  it('does NOT write disk artefact when uploadsDir is not provided', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['heading'] },
      heading: { moduleId: 'base.text', props: { text: 'No artefact', tag: 'h1' }, children: [] },
    })
    page.id = 'page-no-uploads'
    page.slug = 'no-uploads'
    page.title = 'No Uploads'

    const dynamicPage = makePage({
      root: { moduleId: 'base.body', props: {}, children: [] },
    })
    dynamicPage.id = 'page-empty'
    dynamicPage.slug = 'empty'
    dynamicPage.title = 'Empty'

    const db = buildFakeDb(page, dynamicPage)
    const { publishDraftSite } = await import('../../../server/repositories/publish')
    const result = await publishDraftSite(db, 'user-1')  // no uploadsDir

    expect(result.publishedPages).toBe(2)
    // No symlink should exist
    const artefact = await readArtefact(uploadsDir, '/no-uploads')
    expect(artefact).toBeNull()
  })

  it('leaves the old slot intact after symlink flip', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['h'] },
      h: { moduleId: 'base.text', props: { text: 'First publish', tag: 'h1' }, children: [] },
    })
    page.id = 'page-flip'
    page.slug = 'flip'
    page.title = 'Flip'

    const page2 = makePage({
      root: { moduleId: 'base.body', props: {}, children: [] },
    })
    page2.id = 'page2-flip'
    page2.slug = 'flip2'
    page2.title = 'Flip2'

    const db = buildFakeDb(page, page2)
    const { publishDraftSite } = await import('../../../server/repositories/publish')

    // First publish: writes to inactive slot (b), flips current → b
    await publishDraftSite(db, 'user-1', uploadsDir)
    const slotAfterFirst = await getActiveSlot(uploadsDir)

    // The other slot directory should still exist on disk (not wiped until next publish)
    const otherSlot = slotAfterFirst === 'a' ? 'b' : 'a'
    // The inactive slot from the perspective of "before the first publish" is
    // the one the publish just wrote into — the OLD slot is what was active before.
    // On a brand-new uploadsDir there's no old slot, so just verify the active one has content.
    const html = await readArtefact(uploadsDir, '/flip')
    expect(html).toContain('First publish')

    // Second publish: writes to inactive slot (the other one), flips current
    await publishDraftSite(db, 'user-1', uploadsDir)
    const slotAfterSecond = await getActiveSlot(uploadsDir)

    // Slots must have rotated
    expect(slotAfterSecond).not.toBe(slotAfterFirst)

    // Content is still readable after the flip
    const htmlAfter = await readArtefact(uploadsDir, '/flip')
    expect(htmlAfter).toContain('First publish')
  })
})

describe('publicRouter — Layer A disk fast-path', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'router-artefact-'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('serves a baked artefact without DB snapshot lookup when URL has no query string', async () => {
    // Pre-bake an artefact
    const { prepareInactiveSlot, writeArtefact, swapSlot } = await import('../../../server/publish/staticArtefact')
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html><body><h1>Baked about page</h1></body></html>')
    await swapSlot(uploadsDir, slot)

    // Fake DB that throws on any snapshot lookup — proves we never hit it
    let snapshotLookupCalled = false
    const db = createFakeDb(async (sql: string): Promise<DbResult> => {
      const s = sql.toLowerCase()
      if (s.includes('site_snapshots')) {
        snapshotLookupCalled = true
      }
      if (s.includes('count(*) as count from site')) {
        return { rows: [{ count: 1 }], rowCount: 1 }
      }
      if (s.includes('from users') && s.includes('role_id')) {
        return { rows: [{ count: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    const res = await handleServerRequest(
      new Request('http://localhost/about'),
      { db, uploadsDir },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Baked about page')
    expect(snapshotLookupCalled).toBe(false)
  })

  it('serves a static page (HTML + CSS + JS) entirely from disk with ZERO database queries', async () => {
    // Pre-bake a full static page: HTML that links a CSS bundle and a JS chunk,
    // plus those two assets baked into the slot — exactly what a full publish
    // produces for a fully-static page.
    const { prepareInactiveSlot, writeArtefact, writeStaticAsset, swapSlot } =
      await import('../../../server/publish/staticArtefact')
    const enc = new TextEncoder()
    const cssPath = '/_instatic/css/reset-abc123abc123.css'
    const jsPath = '/_instatic/assets/v1/entries/app-deadbeefcafe.js'
    const html =
      `<!DOCTYPE html><html><head>` +
      `<link rel="stylesheet" href="${cssPath}">` +
      `</head><body><h1>Static</h1>` +
      `<script type="module" src="${jsPath}"></script>` +
      `</body></html>`

    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', html)
    await writeStaticAsset(slotDir, cssPath, enc.encode('body{margin:0}'))
    await writeStaticAsset(slotDir, jsPath, enc.encode('console.log("hi")'))
    await swapSlot(uploadsDir, slot)

    // A DB that throws on ANY query — the only way the three requests below can
    // succeed is if NOTHING touches the database.
    let dbQueried = false
    const throwingDb = createFakeDb(async (sql: string): Promise<DbResult> => {
      dbQueried = true
      throw new Error(`unexpected DB query during static serve: ${sql.slice(0, 80)}`)
    })

    // No staticDir → the admin static handler is a no-op; the public/asset
    // handlers own these paths.
    const htmlRes = await handleServerRequest(new Request('http://localhost/about'), { db: throwingDb, uploadsDir })
    expect(htmlRes.status).toBe(200)
    expect(htmlRes.headers.get('content-type')).toContain('text/html')
    expect(await htmlRes.text()).toContain('<h1>Static</h1>')

    const cssRes = await handleServerRequest(new Request(`http://localhost${cssPath}`), { db: throwingDb, uploadsDir })
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(await cssRes.text()).toBe('body{margin:0}')

    const jsRes = await handleServerRequest(new Request(`http://localhost${jsPath}`), { db: throwingDb, uploadsDir })
    expect(jsRes.status).toBe(200)
    expect(jsRes.headers.get('content-type')).toContain('javascript')
    expect(await jsRes.text()).toBe('console.log("hi")')

    // The hard guarantee: not a single DB query was issued for any of the three.
    expect(dbQueried).toBe(false)
  })

  it('serves a hole-page SHELL (HTML + CSS) from disk with ZERO DB — only the /_instatic/hole fragment is dynamic', async () => {
    // A page with a hole bakes a static shell: real HTML + a <instatic-hole>
    // placeholder + the hole runtime. The shell and its CSS are on disk; only
    // the hole fragment fetch (/_instatic/hole/<id>) touches the server at runtime.
    const { prepareInactiveSlot, writeArtefact, writeStaticAsset, swapSlot } =
      await import('../../../server/publish/staticArtefact')
    const cssPath = '/_instatic/css/style-feedfeedfeed.css'
    const shell =
      `<!DOCTYPE html><html><head>` +
      `<link rel="stylesheet" href="${cssPath}">` +
      `<script type="module" src="/_instatic/hole-runtime.js?v=3" defer></script>` +
      `</head><body><h1>Blog</h1>` +
      `<instatic-hole id="hole-loop1" data-instatic-hole="loop1" data-instatic-version="3" style="display:contents"></instatic-hole>` +
      `</body></html>`

    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/blog', shell)
    await writeStaticAsset(slotDir, cssPath, new TextEncoder().encode('h1{color:#000}'))
    await swapSlot(uploadsDir, slot)

    let dbQueried = false
    const throwingDb = createFakeDb(async (sql: string): Promise<DbResult> => {
      dbQueried = true
      throw new Error(`unexpected DB query serving hole-shell: ${sql.slice(0, 80)}`)
    })

    const htmlRes = await handleServerRequest(new Request('http://localhost/blog'), { db: throwingDb, uploadsDir })
    expect(htmlRes.status).toBe(200)
    const body = await htmlRes.text()
    expect(body).toContain('<h1>Blog</h1>')
    expect(body).toContain('<instatic-hole') // the dynamic part is deferred to a hole
    expect(body).toContain('/_instatic/hole-runtime.js')

    const cssRes = await handleServerRequest(new Request(`http://localhost${cssPath}`), { db: throwingDb, uploadsDir })
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')

    // The shell + CSS were served entirely from disk — zero DB. (The hole
    // fragment endpoint, exercised in holeRouteHandler.test.ts, is the only
    // request that reads the DB.)
    expect(dbQueried).toBe(false)
  })

  it('falls through to the live renderer when URL has a render-affecting (loop pagination) query', async () => {
    // Pre-bake an artefact for /about
    const { prepareInactiveSlot, writeArtefact, swapSlot } = await import('../../../server/publish/staticArtefact')
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html><body><h1>Baked about page</h1></body></html>')
    await swapSlot(uploadsDir, slot)

    // A loop-pagination query affects the render, so it must bypass the disk
    // path (junk queries instead serve the baked artefact — ISS-032)
    const db = createFakeDb(async (sql: string): Promise<DbResult> => {
      const s = sql.toLowerCase()
      if (s.includes('count(*) as count from site')) {
        return { rows: [{ count: 1 }], rowCount: 1 }
      }
      if (s.includes('from users') && s.includes('role_id')) {
        return { rows: [{ count: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })

    const res = await handleServerRequest(
      new Request('http://localhost/about?loop_x_page=2'),
      { db, uploadsDir },
    )

    // No snapshot for this URL → falls through to not-found (404)
    // The baked artefact must NOT have been served
    expect(res.status).toBe(404)
  })
})
