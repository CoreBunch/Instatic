/**
 * Publish repository — data access for published site snapshots.
 *
 * Pages are stored in `data_rows` (table_id = 'pages'). A full publish
 * stores the published `SiteDocument` ONCE in `site_snapshots` (with a
 * content hash and the pre-serialised runtime importmap); each published
 * page version is a row in `data_row_versions` that references it via
 * `site_snapshot_id` and carries only its page-scoped `runtime_assets_json`.
 * Readers reassemble the `PublishedPageSnapshot` shape from the join, so
 * publishing N pages stores the site document once instead of N times.
 *
 * This module is data access ONLY. The full-publish orchestration (runtime
 * builds, rendering, Layer A baking, slot swap, cache bump) lives in
 * `server/publish/publishSite.ts` and calls down into this repository.
 *
 * Public API:
 *   getDraftSiteDocument      — assemble the draft SiteDocument from rows
 *   persistSitePublish        — transactional write of one publish
 *   getPublishedPageBySlug    — look up a published page snapshot by slug
 *   getPublishedPageSnapshotById — same, by page row id
 *   getLatestPublishedSiteSnapshot — first published page snapshot (for 404s etc.)
 *   getDraftPublishStatus     — compare draft vs published state for the UI
 */
import { createHash } from 'node:crypto'
import type { DataRow } from '@core/data/schemas'
import { PageSchema, SiteShellSchema, type SiteDocument } from '@core/page-tree'
import { VisualComponentSchema } from '@core/visual-components-schema'
import { SavedLayoutSchema } from '@core/layouts-schema'
import { LocaleSchema } from '@core/localization-schema'
import { Type, parseValue } from '@core/utils/typeboxHelpers'
import { nanoid } from 'nanoid'
import { isTemplatePage } from '@core/templates'
import { readPreviousPublishedRoute, savePublishedRedirect } from './data/publish'
import { PublishedPageRuntimeAssetsSchema, type PublishedPageRuntimeAssets } from '@core/site-runtime'
import type { PublishedRuntimePackageImportmap } from '@core/publisher'
import { placeholder, type DbClient } from '../db/client'
import type { BuiltRuntimeAssetFile } from '../publish/runtime/bundleScripts'
import { getDraftSite } from './site'
import { getDataTable, listDataRows } from './data'
import { pageFromRow } from '../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../src/core/data/componentFromRow'
import { validateVisualComponents } from '../../src/core/persistence/validate'
import { savePublishedRuntimeAssets } from './runtimeAsset'
import { getDefaultLocale, getLocale, listLocales, listContentLocalizations, setContentLocalizationPublishedVersion } from './localization'
import type { SiteLocalizationContext } from '@core/localization-schema'
import { resolveDataFieldLocalization } from '@core/localization'
import { savedLayoutFromRow } from '@core/data/layoutFromRow'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishedPageSnapshot {
  cmsSnapshotVersion: 1
  /** id of the `data_rows` row for this page (was `pageId` in the old schema). */
  pageRowId: string
  site: SiteDocument
  localeId?: string
  versionId?: string
  siteSnapshotId?: string
  publicPath?: string | null
  runtimeAssets?: PublishedPageRuntimeAssets
  /**
   * Pre-serialised importmap mapping bare specifiers like `three` to URLs
   * served from the host's runtime dependency cache. Stored verbatim in the
   * snapshot so re-renders use the same bytes the CSP hash was computed
   * over. Omitted when the site has no locked runtime dependencies.
   */
  runtimePackageImportmap?: PublishedRuntimePackageImportmap
}

interface DraftPublishStatus {
  hasPublishedVersion: boolean
  draftMatchesPublished: boolean
  draftPages: number
  publishedPages: number
  lastPublishedAt?: string
}

interface PublishStatusRow {
  row_id: string
  content_hash: string
  published_at: string | Date
}

/** Shared SELECT shape for the snapshot getters below. */
interface SnapshotQueryRow {
  row_id: string
  site_json: SiteDocument
  runtime_assets_json: PublishedPageRuntimeAssets | null
  importmap_body: string | null
  importmap_sha256: string | null
  locale_id: string
  version_id: string
  site_snapshot_id: string
  public_path: string | null
}

/** One page's version write within `persistSitePublish`. */
export interface PublishedPageVersionWrite {
  pageId: string
  title: string
  slug: string
  versionId: string
  versionNumber: number
  runtimeAssets: PublishedPageRuntimeAssets | null
  runtimeFiles: BuiltRuntimeAssetFile[]
  localeId: string
  publicPath: string | null
  cells: DataRow['cells']
  /** Dependency snapshots do not change a template's selected live release. */
  activate: boolean
}

export interface PersistSitePublishInput {
  siteSnapshotId: string
  /** The published site document — stored ONCE, referenced by every page version. */
  site: SiteDocument
  serializedImportmap: { body: string; sha256: string } | null
  pages: PublishedPageVersionWrite[]
  publishedByUserId: string | null
}

const PublishedSiteDocumentSchema = Type.Intersect([SiteShellSchema, Type.Object({
  pages: Type.Array(PageSchema),
  visualComponents: Type.Array(VisualComponentSchema),
  layouts: Type.Array(SavedLayoutSchema),
  localeId: Type.Optional(Type.String()),
  locales: Type.Optional(Type.Array(LocaleSchema)),
})])

/** Frozen schedule payloads and publication versions use the same snapshot store. */
export async function saveSiteDocumentSnapshot(db: DbClient, site: SiteDocument): Promise<string> {
  const id = nanoid()
  const { localization: _draftContext, ...withoutDrafts } = site
  const frozen = { ...withoutDrafts, layouts: [] }
  await db`insert into site_snapshots (id, site_json, content_hash) values (${id}, ${frozen}, ${siteContentHash(frozen)})`
  return id
}

export async function getStoredSiteDocument(db: DbClient, id: string): Promise<SiteDocument | null> {
  const { rows } = await db<{ site_json: unknown }>`select site_json from site_snapshots where id = ${id}`
  return rows[0] ? parseValue(PublishedSiteDocumentSchema, rows[0].site_json) : null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Canonical content hash of a site document, stamped on `site_snapshots` at
 * publish time. The publish-status check compares the draft's hash against
 * it — equality is observationally identical to comparing the canonical JSON
 * strings, without fetching or parsing any stored snapshot.
 */
function siteContentHash(site: SiteDocument): string {
  return createHash('sha256').update(canonicalJson(site)).digest('hex')
}

/**
 * `listDataRows` is intentionally recency-ordered for authoring surfaces, but
 * that order is not a stable site-document order: a full publish updates every
 * page's `updated_at`, which can reshuffle an otherwise unchanged collection.
 * Creation order is immutable, with id as the deterministic tie-breaker.
 */
function orderSiteDocumentRows(rows: readonly DataRow[]): DataRow[] {
  return rows.toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
}

/** Reassemble the `PublishedPageSnapshot` shape from the getter join. */
function snapshotFromQueryRow(row: SnapshotQueryRow): PublishedPageSnapshot {
  const runtimeAssets = row.runtime_assets_json ? parseValue(PublishedPageRuntimeAssetsSchema, row.runtime_assets_json) : null
  return {
    cmsSnapshotVersion: 1,
    pageRowId: row.row_id,
    site: parseValue(PublishedSiteDocumentSchema, row.site_json),
    localeId: row.locale_id,
    versionId: row.version_id,
    siteSnapshotId: row.site_snapshot_id,
    publicPath: row.public_path,
    ...(runtimeAssets && runtimeAssets.scripts.length > 0
      ? { runtimeAssets }
      : {}),
    ...(row.importmap_body && row.importmap_sha256
      ? { runtimePackageImportmap: { body: row.importmap_body, sha256: row.importmap_sha256 } }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// Public functions
// ---------------------------------------------------------------------------

/**
 * Assemble the current draft `SiteDocument` from the site shell plus the
 * `pages` and `components` data rows. Returns `null` when no draft site
 * exists yet. Saved layouts are editor-only; publishing ignores them.
 */
export async function getDraftSiteDocument(db: DbClient, options: { localeId?: string } = {}): Promise<SiteDocument | null> {
  return db.transaction((tx) => getDraftSiteDocumentInTx(tx, options))
}

/** Assemble inside an existing transaction, including callers reading sync metadata. */
export async function getDraftSiteDocumentInTx(db: DbClient, options: { localeId?: string }): Promise<SiteDocument | null> {
  const shell = await getDraftSite(db)
  if (!shell) return null

  const locale = options.localeId ? await getLocale(db, options.localeId) : await getDefaultLocale(db)
  if (!locale) throw new Error('Language not found')
  const [pageRows, vcRows, layoutRows, locales] = await Promise.all([
    listDataRows(db, 'pages', { localeId: locale.id }),
    listDataRows(db, 'components', { localeId: locale.id }),
    listDataRows(db, 'layouts', { localeId: locale.id }),
    listLocales(db),
  ])
  const visualComponents = validateVisualComponents(
    orderSiteDocumentRows(vcRows)
      .flatMap((r) => { const vc = visualComponentFromRow(r); return vc ? [vc] : [] })
  )
  const contentRows = [...pageRows, ...vcRows, ...layoutRows]
  const tables = await Promise.all(['pages', 'components', 'layouts'].map((tableId) => getDataTable(db, tableId)))
  const fieldLocalizations = new Map(tables.filter((table) => table !== null).map((table) => [table.id,
    Object.fromEntries(table.fields.map((field) => [field.id, resolveDataFieldLocalization(field)])),
  ]))
  const variants = await listContentLocalizations(db, { rowIds: contentRows.map((row) => row.id) })
  const localization: SiteLocalizationContext = {
    fieldLocalizations: Object.fromEntries(fieldLocalizations),
    rows: Object.fromEntries(contentRows.map((row) => [row.id, {
      tableId: row.tableId === 'pages' ? 'pages' : row.tableId === 'components' ? 'components' : 'layouts',
      sharedCells: row.sharedCells,
      localizations: Object.fromEntries(variants.filter((variant) => variant.rowId === row.id).map((variant) => [variant.localeId, {
        cells: variant.cells, slug: variant.slug, translationMeta: variant.translationMeta,
      }])),
    }])),
  }
  return {
    ...shell,
    locales,
    localeId: locale.id,
    localization,
    pages: orderSiteDocumentRows(pageRows).map(pageFromRow),
    visualComponents,
    layouts: orderSiteDocumentRows(layoutRows).flatMap((row) => {
      const layout = savedLayoutFromRow(row)
      return layout ? [layout] : []
    }),
  }
}

export async function getDraftPublishStatus(db: DbClient, options: { localeId?: string } = {}): Promise<DraftPublishStatus> {
  const draft = await getDraftSiteDocument(db, options)
  if (!draft) return { hasPublishedVersion: false, draftMatchesPublished: false, draftPages: 0, publishedPages: 0 }
  const pages = draft.pages.filter((page) => !isTemplatePage(page))
  const { rows } = await db<PublishStatusRow>`
    select content_rows.id as row_id, snapshots.content_hash, versions.published_at
    from data_rows content_rows
    join data_row_localizations variants on variants.row_id = content_rows.id
    join data_row_versions versions on versions.id = variants.active_version_id
      and versions.row_id = variants.row_id and versions.locale_id = variants.locale_id
    join site_snapshots snapshots on snapshots.id = versions.site_snapshot_id
    join site_locales locales on locales.id = variants.locale_id
    where content_rows.table_id = 'pages' and content_rows.deleted_at is null
      and variants.locale_id = ${draft.localeId} and variants.availability = 'online'
      and locales.enabled = ${true} and versions.public_path is not null
  `
  const { localization: _context, ...withoutContext } = draft
  const hash = siteContentHash({ ...withoutContext, layouts: [] })
  const lastPublishedAt = rows.map((row) => new Date(row.published_at).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0]
  return {
    hasPublishedVersion: rows.length > 0,
    draftMatchesPublished: rows.length === pages.length && rows.every((row) => row.content_hash === hash),
    draftPages: pages.length, publishedPages: rows.length,
    ...(lastPublishedAt ? { lastPublishedAt: new Date(lastPublishedAt).toISOString() } : {}),
  }
}

/**
 * Transactional write of one full publish: the site snapshot row plus one
 * `data_row_versions` row (and its runtime asset files) per page, flipping
 * each page row to `published`. DB writes only — every expensive non-DB
 * build (runtime bundling, rendering) happens in the orchestrator BEFORE
 * this is called, so the SQLite adapter's serialized transaction chain is
 * held for milliseconds, not seconds.
 */
export async function persistSitePublish(
  db: DbClient,
  inputs: PersistSitePublishInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    for (const input of inputs) {
    // The site document is stored ONCE per publish; every page version row
    // references it. The content hash powers the publish-status check without
    // ever re-fetching the document.
    await tx`
      insert into site_snapshots (id, site_json, content_hash, importmap_body, importmap_sha256)
      values (
        ${input.siteSnapshotId},
        ${input.site},
        ${siteContentHash(input.site)},
        ${input.serializedImportmap?.body ?? null},
        ${input.serializedImportmap?.sha256 ?? null}
      )
    `

    for (const page of input.pages) {
      const previous = page.activate ? await readPreviousPublishedRoute(tx, page.pageId, page.localeId) : null
      await tx`
        insert into data_row_versions
          (id, row_id, locale_id, version_number, cells_json, slug, public_path, site_snapshot_id, runtime_assets_json, published_by_user_id)
        values (
          ${page.versionId},
          ${page.pageId},
          ${page.localeId},
          ${page.versionNumber},
          ${page.cells},
          ${page.slug},
          ${page.publicPath},
          ${input.siteSnapshotId},
          ${page.runtimeAssets},
          ${input.publishedByUserId}
        )
      `
      await savePublishedRuntimeAssets(tx, page.versionId, page.runtimeFiles)
      if (!page.activate) continue
      await tx`
        insert into data_row_localizations (row_id, locale_id, slug)
        values (${page.pageId}, ${page.localeId}, ${page.slug})
        on conflict (row_id, locale_id) do nothing
      `
      const localization = await setContentLocalizationPublishedVersion(tx, page.pageId, page.localeId, page.versionId, input.publishedByUserId)
      if (!localization) throw new Error(`Page "${page.pageId}" disappeared during publication`)
      if (previous && previous.path !== page.publicPath) {
        await savePublishedRedirect(tx, page.pageId, 'pages', page.localeId, previous.path)
      }
    }
    }
  })
}

export async function getPublishedPageBySlug(
  db: DbClient,
  slug: string,
  localeId?: string,
): Promise<PublishedPageSnapshot | null> {
  return readPageSnapshot(db, { localeId, slug })
}

export async function getPublishedPageSnapshotById(
  db: DbClient,
  pageId: string,
  localeId?: string,
  siteSnapshotId?: string,
): Promise<PublishedPageSnapshot | null> {
  return readPageSnapshot(db, { localeId, pageId, siteSnapshotId })
}

/**
 * Any published page's snapshot, used purely as a carrier for `site_json` —
 * routes that are not themselves pages (entry routes, the 404) need the site
 * document to resolve their template chain.
 *
 * It deliberately does NOT carry runtime assets. Those are per-page, and the
 * arbitrary page this returns (the first created, per the `order by`) is
 * almost never the page that renders the request. Letting its
 * `runtime_assets_json` ride along meant every entry route on a site served
 * one unrelated page's scripts, with the scope predicate never consulted.
 * Callers needing a manifest resolve the page that actually renders and take
 * its own — see `server/publish/entryTemplateSnapshot.ts`.
 */
export async function getLatestPublishedSiteSnapshot(
  db: DbClient,
  localeId?: string,
  siteSnapshotId?: string,
): Promise<PublishedPageSnapshot | null> {
  const snapshot = await readPageSnapshot(db, { localeId, siteSnapshotId })
  if (!snapshot) return null
  const { runtimeAssets: _runtimeAssets, ...withoutRuntime } = snapshot
  return withoutRuntime
}

async function readPageSnapshot(
  db: DbClient,
  options: { localeId?: string; slug?: string; pageId?: string; siteSnapshotId?: string },
): Promise<PublishedPageSnapshot | null> {
  const localeId = options.localeId ?? (await getDefaultLocale(db)).id
  const values: unknown[] = [localeId, true]
  const conditions = [
    `versions.locale_id = ${placeholder(db.dialect, 1)}`,
    `locales.enabled = ${placeholder(db.dialect, 2)}`,
    "content_rows.table_id = 'pages'",
    ...(!options.siteSnapshotId ? ['content_rows.deleted_at is null'] : []),
  ]
  for (const [column, value] of [
    ['versions.slug', options.slug], ['content_rows.id', options.pageId], ['versions.site_snapshot_id', options.siteSnapshotId],
  ] as const) {
    if (value !== undefined) {
      values.push(value)
      conditions.push(`${column} = ${placeholder(db.dialect, values.length)}`)
    }
  }
  // A content version pins the template release it was published with. Such
  // dependencies may be historical; direct public reads use only active ones.
  const activeJoin = options.siteSnapshotId ? '' : `
    join data_row_localizations variants on variants.row_id = versions.row_id
      and variants.locale_id = versions.locale_id and variants.active_version_id = versions.id
      and variants.availability = 'online'`
  const { rows } = await db.unsafe<SnapshotQueryRow>(`
    select content_rows.id as row_id, versions.id as version_id, versions.locale_id,
           versions.site_snapshot_id, versions.public_path, versions.runtime_assets_json,
           site_snapshots.site_json, site_snapshots.importmap_body, site_snapshots.importmap_sha256
    from data_row_versions versions
    join data_rows content_rows on content_rows.id = versions.row_id
    join site_snapshots on site_snapshots.id = versions.site_snapshot_id
    join site_locales locales on locales.id = versions.locale_id
    ${activeJoin}
    where ${conditions.join(' and ')}
    order by versions.published_at desc, versions.version_number desc
    limit 1
  `, values)
  return rows[0] ? snapshotFromQueryRow(rows[0]) : null
}
