/**
 * Publish pipeline & public serving benchmark.
 *
 * Exercises the FULL publish path against an isolated SQLite DB seeded
 * through the real repositories — `saveDraftSite` + `createDataRow` for the
 * draft, `publishDraftSite` for the snapshot bake — and then the public
 * serving path through `renderPublicResolution` exactly as the visitor
 * router invokes it. Everything goes through stable public APIs so the same
 * bench code measures before AND after pipeline optimizations.
 *
 * Scenarios:
 *   - Full publish wall time at N draft pages (~150 nodes each), plus the
 *     SQLite file growth per publish — the snapshot storage amplification.
 *   - `getDraftPublishStatus` cost on a published site (draft-vs-published
 *     comparison the admin UI polls).
 *   - Warm dynamic-route serving: `renderPublicResolution` WITHOUT an
 *     uploadsDir, so Layer A is skipped and the request exercises route
 *     resolution + the Layer B LRU. The cache and publishState are
 *     module-level, so warm hits here are the real warm path.
 *   - 404 probe: `renderPublicResolution` on a missing path plus
 *     `getSetupStatus` — what the router pays per unmatched GET.
 *   - Published row-route lookup: `getPublishedDataRowByRoute` against a
 *     table with 10k published rows (the `/posts/<slug>` resolution cost).
 *
 * Every scenario is wrapped so a seeding/publish failure reports an
 * `unavailable` row instead of crashing the suite.
 */
import { resolve } from 'node:path'
import { mkdirSync, existsSync, unlinkSync, rmSync, statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import type { Page, SiteShell } from '../../../src/core/page-tree'
import type { BenchModule, BenchResult, BenchRow, BenchContext } from '../lib/types'
import { summarize, fmtMs, fmtBytes, fmtNum } from '../lib/stats'
import { log } from '../lib/log'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const BENCH_DIR = resolve(REPO_ROOT, '.tmp/benchmarks')
const ADMIN_USER_ID = 'bench-admin'
const NODES_PER_PAGE = 150

// Lazy imports — keep cold startup fast when this bench is skipped.
async function loadServer() {
  // Side effect — registers base modules so the publish renderer finds them.
  await import('../../../src/modules/base')
  const { createSqliteClient } = await import('../../../server/db/sqlite')
  const { runMigrations } = await import('../../../server/db/runMigrations')
  const { sqliteMigrations } = await import('../../../server/db/migrations-sqlite')
  const { saveDraftSite } = await import('../../../server/repositories/site')
  const { getDraftPublishStatus } = await import('../../../server/repositories/publish')
  const { publishDraftSite } = await import('../../../server/publish/publishSite')
  const { createDataRow, listDataRows, listDataRowIdSlugs, updateDataRowDraftCells } = await import('../../../server/repositories/data')
  const { getPublishedDataRowByRoute } = await import('../../../server/repositories/data/publish')
  const { getSetupStatus } = await import('../../../server/repositories/setup')
  const { renderPublicResolution } = await import('../../../server/publish/publicRouter')
  const { pageToCells, pageFromRow } = await import('../../../src/core/data/pageFromRow')
  const { validatePagesForPartialSave } = await import('../../../src/core/persistence/validate')
  const { normalizeSiteRuntimeConfig } = await import('../../../src/core/site-runtime')
  return {
    createSqliteClient,
    runMigrations,
    sqliteMigrations,
    saveDraftSite,
    publishDraftSite,
    getDraftPublishStatus,
    createDataRow,
    listDataRows,
    listDataRowIdSlugs,
    updateDataRowDraftCells,
    getPublishedDataRowByRoute,
    getSetupStatus,
    renderPublicResolution,
    pageToCells,
    pageFromRow,
    validatePagesForPartialSave,
    normalizeSiteRuntimeConfig,
  }
}

type ServerApi = Awaited<ReturnType<typeof loadServer>>
type Db = ReturnType<ServerApi['createSqliteClient']>

// ---------------------------------------------------------------------------
// DB lifecycle helpers (mirrors benches/db.ts)
// ---------------------------------------------------------------------------

async function freshDb(api: ServerApi, label: string): Promise<{ db: Db; path: string }> {
  mkdirSync(BENCH_DIR, { recursive: true })
  const path = resolve(BENCH_DIR, `publish-bench-${label}-${Date.now()}.db`)
  cleanupDbFiles(path)
  const db = api.createSqliteClient(path)
  await api.runMigrations(db, api.sqliteMigrations)
  return { db, path }
}

/** Total on-disk bytes of the SQLite database (main file + WAL + SHM). */
function dbBytes(path: string): number {
  let total = 0
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) total += statSync(file).size
  }
  return total
}

function cleanupDbFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      // best-effort cleanup
    }
  }
}

function unavailableRow(label: string, err: unknown): BenchRow {
  const message = err instanceof Error ? err.message : String(err)
  return { label, metrics: { status: `unavailable: ${message}` } }
}

// ---------------------------------------------------------------------------
// Draft-site seeding through the real repositories
// ---------------------------------------------------------------------------

function makeShell(api: ServerApi): SiteShell {
  return {
    id: 'site-bench',
    name: 'Publish Bench Site',
    files: [],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: api.normalizeSiteRuntimeConfig(undefined),
    breakpoints: [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }],
    settings: { shortcuts: {} } as SiteShell['settings'],
    styleRules: {},
    createdAt: 1000,
    updatedAt: 2000,
  }
}

/**
 * Build a ~`target`-node page tree (base.body root, base.container /
 * base.text children) — same synthetic shape as benches/publisher.ts.
 */
function makeBenchPage(index: number, target: number): Page {
  const nodes: Page['nodes'] = {}
  const rootId = `p${index}-n0`
  nodes[rootId] = {
    id: rootId,
    moduleId: 'base.body',
    props: {},
    breakpointOverrides: {},
    children: [],
    classIds: [],
  }
  let counter = 1
  const queue: string[] = [rootId]
  while (counter < target && queue.length > 0) {
    const parentId = queue.shift()!
    const childCount = Math.min(4, target - counter)
    const kids: string[] = []
    for (let i = 0; i < childCount; i++) {
      const childId = `p${index}-n${counter++}`
      const isContainer = i < 2
      nodes[childId] = {
        id: childId,
        moduleId: isContainer ? 'base.container' : 'base.text',
        props: isContainer
          ? { tag: 'div' }
          : { text: `Lorem ipsum dolor sit amet — node ${childId}`, tag: 'p' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      }
      if (isContainer) queue.push(childId)
      kids.push(childId)
    }
    nodes[parentId] = { ...nodes[parentId], children: kids }
  }
  return {
    id: `bench-page-${index}`,
    slug: index === 0 ? 'index' : `page-${index}`,
    title: `Bench page ${index}`,
    nodes,
    rootNodeId: rootId,
  }
}

/** Seed an owner user + site shell + N draft pages via the real repositories. */
async function seedDraftSite(api: ServerApi, db: Db, pageCount: number): Promise<void> {
  await db`
    insert into users (id, email, email_normalized, display_name, password_hash, role_id)
    values (${ADMIN_USER_ID}, 'bench@example.com', 'bench@example.com', 'Bench Admin', 'bench-hash', 'owner')
  `
  await api.saveDraftSite(db, makeShell(api))
  for (let i = 0; i < pageCount; i++) {
    const page = makeBenchPage(i, NODES_PER_PAGE)
    await api.createDataRow(
      db,
      { id: page.id, tableId: 'pages', cells: api.pageToCells(page), slug: page.slug },
      ADMIN_USER_ID,
    )
  }
}

// ---------------------------------------------------------------------------
// Bench module
// ---------------------------------------------------------------------------

export const publishBench: BenchModule = {
  name: 'publish',
  title: 'Publish pipeline & public serving',
  description: 'Full publishDraftSite wall time + DB growth, publish status check, warm dynamic serving, 404 probe, row-route lookup.',

  async run(ctx: BenchContext): Promise<BenchResult> {
    const api = await loadServer()

    // ---- Full publish wall time scaling ---------------------------------
    log.step('Full publish wall time scaling')
    const publishRows: BenchRow[] = []
    // The largest-N DB is kept alive for the status / warm-serving / 404
    // scenarios below (they must run against a real published site).
    let published: { db: Db; path: string; uploadsDir: string; pageCount: number } | null = null
    const pageCounts = ctx.quick ? [5, 15] : [10, 40]
    for (const n of pageCounts) {
      const isLast = n === pageCounts[pageCounts.length - 1]
      const uploadsDir = resolve(BENCH_DIR, `publish-bench-uploads-${n}-${Date.now()}`)
      let fresh: { db: Db; path: string } | null = null
      try {
        fresh = await freshDb(api, `pages-${n}`)
        await seedDraftSite(api, fresh.db, n)
        const bytesBefore = dbBytes(fresh.path)
        log.step(`  publishing ${fmtNum(n)} pages × ~${NODES_PER_PAGE} nodes…`)
        const t0 = performance.now()
        const result = await api.publishDraftSite(fresh.db, ADMIN_USER_ID, uploadsDir)
        const wallMs = performance.now() - t0
        const growth = dbBytes(fresh.path) - bytesBefore
        if (result.publishedPages !== n) {
          throw new Error(`expected ${n} published pages, got ${result.publishedPages}`)
        }
        publishRows.push({
          label: `${fmtNum(n)} pages × ~${NODES_PER_PAGE} nodes`,
          inputs: { pages: n, nodes_per_page: NODES_PER_PAGE },
          metrics: {
            wall: fmtMs(wallMs),
            per_page: fmtMs(wallMs / n),
            db_growth: fmtBytes(Math.max(0, growth)),
            db_growth_per_page: fmtBytes(Math.max(0, Math.floor(growth / n))),
          },
        })
        log.detail(`    wall=${fmtMs(wallMs)} db_growth=${fmtBytes(Math.max(0, growth))}`)
        if (isLast) {
          published = { db: fresh.db, path: fresh.path, uploadsDir, pageCount: n }
        } else {
          cleanupDbFiles(fresh.path)
          rmSync(uploadsDir, { recursive: true, force: true })
        }
      } catch (err) {
        publishRows.push(unavailableRow(`${fmtNum(n)} pages × ~${NODES_PER_PAGE} nodes`, err))
        if (fresh) cleanupDbFiles(fresh.path)
        rmSync(uploadsDir, { recursive: true, force: true })
      }
    }

    try {
      // ---- Publish status check ------------------------------------------
      log.step('Publish status check (getDraftPublishStatus)')
      const statusRows: BenchRow[] = []
      if (published) {
        try {
          const iters = ctx.quick ? 5 : 20
          const samples: number[] = []
          for (let i = 0; i < iters; i++) {
            const t0 = performance.now()
            const status = await api.getDraftPublishStatus(published.db)
            samples.push(performance.now() - t0)
            if (status.publishedPages !== published.pageCount) {
              throw new Error(`status reported ${status.publishedPages} published pages, expected ${published.pageCount}`)
            }
          }
          const s = summarize(samples)
          statusRows.push({
            label: `${fmtNum(published.pageCount)} published pages`,
            inputs: { pages: published.pageCount, iters },
            metrics: { mean: fmtMs(s.mean), p95: fmtMs(s.p95), max: fmtMs(s.max) },
          })
        } catch (err) {
          statusRows.push(unavailableRow('publish status check', err))
        }
      } else {
        statusRows.push(unavailableRow('publish status check', new Error('publish scenario did not complete')))
      }

      // ---- Warm dynamic-route serving --------------------------------------
      log.step('Warm dynamic-route serving (renderPublicResolution, no uploadsDir)')
      const warmRows: BenchRow[] = []
      if (published) {
        try {
          // No uploadsDir → Layer A is skipped; the request resolves the route
          // against the DB and hits the module-level Layer B LRU when warm.
          const url = new URL('http://localhost/page-1')
          const warmup = await api.renderPublicResolution(published.db, url)
          if (!warmup || warmup.status !== 200) {
            throw new Error(`expected 200 for /page-1, got ${warmup?.status ?? 'null'}`)
          }
          const iters = ctx.quick ? 50 : 300
          const samples: number[] = []
          for (let i = 0; i < iters; i++) {
            const t0 = performance.now()
            const res = await api.renderPublicResolution(published.db, url)
            samples.push(performance.now() - t0)
            if (!res) throw new Error('warm request unexpectedly resolved to not-found')
          }
          const s = summarize(samples)
          warmRows.push({
            label: `GET /page-1 (warm, ${fmtNum(published.pageCount)}-page site)`,
            inputs: { pages: published.pageCount, iters },
            metrics: {
              mean: fmtMs(s.mean),
              p95: fmtMs(s.p95),
              throughput: `${fmtNum(Math.floor(1000 / s.mean))} req/s`,
            },
          })
        } catch (err) {
          warmRows.push(unavailableRow('warm dynamic-route serving', err))
        }
      } else {
        warmRows.push(unavailableRow('warm dynamic-route serving', new Error('publish scenario did not complete')))
      }

      // ---- 404 probe cost ---------------------------------------------------
      log.step('404 probe cost (route resolution miss + setup status)')
      const notFoundRows: BenchRow[] = []
      if (published) {
        try {
          const url = new URL('http://localhost/definitely-missing-404')
          const iters = ctx.quick ? 50 : 300
          // Warmup
          for (let i = 0; i < 3; i++) {
            const res = await api.renderPublicResolution(published.db, url)
            if (res !== null) throw new Error('404 probe unexpectedly resolved')
            await api.getSetupStatus(published.db)
          }
          const samples: number[] = []
          for (let i = 0; i < iters; i++) {
            const t0 = performance.now()
            await api.renderPublicResolution(published.db, url)
            await api.getSetupStatus(published.db)
            samples.push(performance.now() - t0)
          }
          const s = summarize(samples)
          notFoundRows.push({
            label: 'GET /definitely-missing-404 (resolution + setup status)',
            inputs: { pages: published.pageCount, iters },
            metrics: {
              mean: fmtMs(s.mean),
              p95: fmtMs(s.p95),
              throughput: `${fmtNum(Math.floor(1000 / s.mean))} req/s`,
            },
          })
        } catch (err) {
          notFoundRows.push(unavailableRow('404 probe', err))
        }
      } else {
        notFoundRows.push(unavailableRow('404 probe', new Error('publish scenario did not complete')))
      }

      // ---- Published row-route lookup --------------------------------------
      log.step('Published row-route lookup (getPublishedDataRowByRoute)')
      const rowRouteRows: BenchRow[] = []
      {
        const ROWS = ctx.quick ? 2_000 : 10_000
        let fresh: { db: Db; path: string } | null = null
        try {
          fresh = await freshDb(api, 'row-route')
          await fresh.db`
            insert into data_tables (id, name, slug, kind, route_base, singular_label, plural_label)
            values ('bench_posts', 'Bench Posts', 'bench-posts', 'postType', '/posts', 'Post', 'Posts')
          `
          log.step(`  seeding ${fmtNum(ROWS)} published rows…`)
          const db = fresh.db
          await db.transaction(async (tx) => {
            for (let i = 0; i < ROWS; i++) {
              const rowId = `bp-row-${i}`
              const versionId = `bp-ver-${i}`
              const slug = `post-${i}`
              // active_version_id ↔ row_id FKs are circular per row: insert the
              // row first (active NULL), then the version, then link them.
              await tx`
                insert into data_rows (id, table_id, cells_json, slug, status)
                values (${rowId}, 'bench_posts', ${{ title: `Post ${i}` }}, ${slug}, 'published')
              `
              await tx`
                insert into data_row_versions (id, row_id, version_number, cells_json, slug)
                values (${versionId}, ${rowId}, 1, ${{ title: `Post ${i}` }}, ${slug})
              `
              await tx`update data_rows set active_version_id = ${versionId} where id = ${rowId}`
            }
          })
          const targetSlug = `post-${Math.floor(ROWS * 0.7777)}`
          // Warmup + sanity
          for (let i = 0; i < 3; i++) {
            const row = await api.getPublishedDataRowByRoute(fresh.db, '/posts', targetSlug)
            if (!row) throw new Error(`seeded row ${targetSlug} not found by route`)
          }
          const iters = ctx.quick ? 50 : 200
          const samples: number[] = []
          for (let i = 0; i < iters; i++) {
            const t0 = performance.now()
            await api.getPublishedDataRowByRoute(fresh.db, '/posts', targetSlug)
            samples.push(performance.now() - t0)
          }
          const s = summarize(samples)
          rowRouteRows.push({
            label: `lookup /posts/${targetSlug} among ${fmtNum(ROWS)} published rows`,
            inputs: { rows: ROWS, iters },
            metrics: {
              mean: fmtMs(s.mean),
              p95: fmtMs(s.p95),
              throughput: `${fmtNum(Math.floor(1000 / s.mean))} lookups/s`,
            },
          })
        } catch (err) {
          rowRouteRows.push(unavailableRow(`row-route lookup @ ${fmtNum(ROWS)} rows`, err))
        } finally {
          if (fresh) cleanupDbFiles(fresh.path)
        }
      }

      // ---- Site save round-trip (editor autosave cost) ---------------------
      log.step('Site save round-trip (one-edit autosave)')
      const saveRows: BenchRow[] = []
      {
        const SAVE_PAGES = ctx.quick ? 15 : 60
        const SAVE_NODES = ctx.quick ? 100 : 300
        let fresh: { db: Db; path: string } | null = null
        try {
          fresh = await freshDb(api, 'save-roundtrip')
          await fresh.db`
            insert into users (id, email, email_normalized, display_name, password_hash, role_id)
            values (${ADMIN_USER_ID}, 'bench@example.com', 'bench@example.com', 'Bench Admin', 'bench-hash', 'owner')
          `
          const shell = makeShell(api)
          await api.saveDraftSite(fresh.db, shell)
          for (let i = 0; i < SAVE_PAGES; i++) {
            const page = makeBenchPage(i, SAVE_NODES)
            await api.createDataRow(
              fresh.db,
              { id: page.id, tableId: 'pages', cells: api.pageToCells(page), slug: page.slug },
              ADMIN_USER_ID,
            )
          }
          const rows = await api.listDataRows(fresh.db, 'pages')
          const pages = rows.map(api.pageFromRow)

          const iters = ctx.quick ? 3 : 8
          const samples: number[] = []
          let payloadBytes = 0
          for (let iter = 0; iter < iters; iter++) {
            // One-prop edit on one page — the canonical autosave trigger.
            const target = pages[iter % pages.length]
            const textNodeId = Object.keys(target.nodes).find(
              (id) => target.nodes[id].moduleId === 'base.text',
            )!
            const edited: Page = {
              ...target,
              nodes: {
                ...target.nodes,
                [textNodeId]: {
                  ...target.nodes[textNodeId],
                  props: { ...target.nodes[textNodeId].props, text: `edited ${iter}` },
                },
              },
            }
            pages[iter % pages.length] = edited

            // What the editor ships and what the PUT /pages handler then does:
            // validate the CHANGED pages against the stored (id, slug) roster,
            // then reconcile only those rows (roster diff drives reaping).
            const pageIds = pages.map((p) => p.id)
            payloadBytes = JSON.stringify({ changedPages: [edited], pageIds }).length
            const t0 = performance.now()
            const existingIdSlugs = await api.listDataRowIdSlugs(fresh.db, 'pages')
            const validated = api.validatePagesForPartialSave([edited], [], existingIdSlugs)
            const db = fresh.db
            await db.transaction(async (tx) => {
              const existingIds = new Set((await api.listDataRowIdSlugs(tx, 'pages')).map((r) => r.id))
              for (const page of validated) {
                if (existingIds.has(page.id)) {
                  await api.updateDataRowDraftCells(
                    tx,
                    page.id,
                    { cells: api.pageToCells(page), slug: page.slug },
                    ADMIN_USER_ID,
                  )
                }
              }
            })
            samples.push(performance.now() - t0)
          }
          const s = summarize(samples)
          saveRows.push({
            label: `one-prop edit, ${fmtNum(SAVE_PAGES)} pages × ~${fmtNum(SAVE_NODES)} nodes`,
            inputs: { pages: SAVE_PAGES, nodes_per_page: SAVE_NODES, iters },
            metrics: {
              payload: fmtBytes(payloadBytes),
              mean: fmtMs(s.mean),
              p95: fmtMs(s.p95),
            },
          })
          log.detail(`    payload=${fmtBytes(payloadBytes)} mean=${fmtMs(s.mean)}`)
        } catch (err) {
          saveRows.push(unavailableRow('site save round-trip', err))
        } finally {
          if (fresh) cleanupDbFiles(fresh.path)
        }
      }

      const largestPublishRow = publishRows[publishRows.length - 1]
      const statusRow = statusRows[0]
      const warmRow = warmRows[0]
      const rowRouteRow = rowRouteRows[0]
      const saveRow = saveRows[0]

      return {
        name: this.name,
        title: this.title,
        headline: {
          [`publish ${largestPublishRow?.label ?? '—'}`]: largestPublishRow?.metrics.wall ?? '—',
          'status check (mean)': statusRow?.metrics.mean ?? '—',
          'warm dynamic GET (mean)': warmRow?.metrics.mean ?? '—',
          'row-route lookup (mean)': rowRouteRow?.metrics.mean ?? '—',
          'save round-trip (mean)': saveRow?.metrics.mean ?? '—',
        },
        sections: [
          {
            title: 'Full publish wall time scaling',
            intro:
              'End-to-end `publishDraftSite` against an isolated SQLite DB seeded through the real repositories — N draft pages of ~150 nodes each, full snapshot bake + Layer A artefact write. `db_growth` is the on-disk SQLite growth (main + WAL) from one publish: the snapshot storage amplification.',
            rows: publishRows,
          },
          {
            title: 'Publish status check',
            intro:
              'Cost of `getDraftPublishStatus` — the draft-vs-published comparison the admin UI polls. Loads every active published snapshot and canonicalises both sides.',
            rows: statusRows,
          },
          {
            title: 'Warm dynamic-route serving',
            intro:
              'Repeated `renderPublicResolution` for one published page WITHOUT an uploadsDir, forcing the dynamic path: route resolution against the DB plus the module-level Layer B LRU (first call warms it). This is what every dynamic request pays once the cache is hot.',
            rows: warmRows,
          },
          {
            title: '404 probe cost',
            intro:
              'Per-iteration cost of `renderPublicResolution` on a path that matches nothing plus `getSetupStatus` — modelling what the router does for every unmatched GET before answering 404.',
            rows: notFoundRows,
          },
          {
            title: 'Published row-route lookup',
            intro:
              'Cost of `getPublishedDataRowByRoute` (the `/posts/<slug>` public lookup) against a table with thousands of published rows, each with an active version. Sensitive to indexing on the versions join.',
            rows: rowRouteRows,
          },
          {
            title: 'Site save round-trip',
            intro:
              'Models the editor autosave after a ONE-PROP edit: the JSON payload the client ships to PUT /pages plus the server-side work the handler performs (validatePages over the saved roster + the reconcile transaction). HTTP/auth overhead excluded. This section mirrors the save protocol of the commit it runs at.',
            rows: saveRows,
          },
        ],
      }
    } finally {
      if (published) {
        cleanupDbFiles(published.path)
        rmSync(published.uploadsDir, { recursive: true, force: true })
      }
    }
  },
}
