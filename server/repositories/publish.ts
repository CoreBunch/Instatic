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
import type { SiteDocument } from '@core/page-tree'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import type { PublishedRuntimePackageImportmap } from '@core/publisher'
import type { DbClient } from '../db/client'
import type { BuiltRuntimeAssetFile } from '../publish/runtime/bundleScripts'
import { getDraftSite } from './site'
import { listDataRows } from './data'
import { pageFromRow } from '../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../src/core/data/componentFromRow'
import { validateVisualComponents } from '../../src/core/persistence/validate'
import { savePublishedRuntimeAssets } from './runtimeAsset'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishedPageSnapshot {
  cmsSnapshotVersion: 1
  /** id of the `data_rows` row for this page (was `pageId` in the old schema). */
  pageRowId: string
  site: SiteDocument
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
}

export interface PersistSitePublishInput {
  siteSnapshotId: string
  /** The published site document — stored ONCE, referenced by every page version. */
  site: SiteDocument
  serializedImportmap: { body: string; sha256: string } | null
  pages: PublishedPageVersionWrite[]
  publishedByUserId: string
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

/** Reassemble the `PublishedPageSnapshot` shape from the getter join. */
function snapshotFromQueryRow(row: SnapshotQueryRow): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId: row.row_id,
    site: row.site_json,
    ...(row.runtime_assets_json && row.runtime_assets_json.scripts.length > 0
      ? { runtimeAssets: row.runtime_assets_json }
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
export async function getDraftSiteDocument(db: DbClient): Promise<SiteDocument | null> {
  const shell = await getDraftSite(db)
  if (!shell) return null

  const [pageRows, vcRows] = await Promise.all([
    listDataRows(db, 'pages'),
    listDataRows(db, 'components'),
  ])
  const visualComponents = validateVisualComponents(
    vcRows.flatMap((r) => { const vc = visualComponentFromRow(r); return vc ? [vc] : [] })
  )
  return {
    ...shell,
    pages: pageRows.map(pageFromRow),
    visualComponents,
    layouts: [],
  }
}

export async function getDraftPublishStatus(db: DbClient): Promise<DraftPublishStatus> {
  const draftSite = await getDraftSiteDocument(db)
  if (!draftSite) {
    return {
      hasPublishedVersion: false,
      draftMatchesPublished: false,
      draftPages: 0,
      publishedPages: 0,
    }
  }

  // Only the per-publish content hash is fetched — never the stored site
  // document. Comparing the draft's hash against each row's stamped hash is
  // observationally identical to comparing canonical JSON strings, but costs
  // one draft serialisation instead of one per published page.
  const { rows: publishedRows } = await db<PublishStatusRow>`
    select data_rows.id as row_id,
           site_snapshots.content_hash,
           data_row_versions.published_at
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    join site_snapshots on site_snapshots.id = data_row_versions.site_snapshot_id
    where data_rows.table_id = 'pages'
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
    order by data_rows.created_at asc
  `

  const draftSiteHash = siteContentHash(draftSite)
  const draftPageIds = new Set(draftSite.pages.map((page) => page.id))
  const draftMatchesPublished =
    publishedRows.length === draftSite.pages.length &&
    publishedRows.every((row) =>
      draftPageIds.has(row.row_id) &&
      row.content_hash === draftSiteHash
    )
  const lastPublishedAt = publishedRows
    .map((row) => new Date(row.published_at).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0]

  return {
    hasPublishedVersion: publishedRows.length > 0,
    draftMatchesPublished,
    draftPages: draftSite.pages.length,
    publishedPages: publishedRows.length,
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
  input: PersistSitePublishInput,
): Promise<void> {
  await db.transaction(async (tx) => {
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
      await tx`
        insert into data_row_versions
          (id, row_id, version_number, cells_json, slug, site_snapshot_id, runtime_assets_json, published_by_user_id)
        values (
          ${page.versionId},
          ${page.pageId},
          ${page.versionNumber},
          ${{ title: page.title, slug: page.slug }},
          ${page.slug},
          ${input.siteSnapshotId},
          ${page.runtimeAssets},
          ${input.publishedByUserId}
        )
      `
      await savePublishedRuntimeAssets(tx, page.versionId, page.runtimeFiles)
      const { rowCount } = await tx`
        update data_rows
        set active_version_id = ${page.versionId},
            status = 'published',
            published_by_user_id = ${input.publishedByUserId},
            published_at = current_timestamp,
            updated_by_user_id = ${input.publishedByUserId},
            updated_at = current_timestamp
        where id = ${page.pageId}
          and deleted_at is null
      `
      // The page was read before the transaction opened; if a concurrent save
      // reaped it in between, don't leave an orphan version pointing at it.
      if (rowCount === 0) {
        await tx`delete from data_row_versions where id = ${page.versionId}`
      }
    }
  })
}

export async function getPublishedPageBySlug(
  db: DbClient,
  slug: string,
): Promise<PublishedPageSnapshot | null> {
  const { rows } = await db<SnapshotQueryRow>`
    select data_rows.id as row_id,
           site_snapshots.site_json,
           data_row_versions.runtime_assets_json,
           site_snapshots.importmap_body,
           site_snapshots.importmap_sha256
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    join site_snapshots on site_snapshots.id = data_row_versions.site_snapshot_id
    where data_rows.table_id = 'pages'
      and data_rows.slug = ${slug}
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
    limit 1
  `
  return rows[0] ? snapshotFromQueryRow(rows[0]) : null
}

export async function getPublishedPageSnapshotById(
  db: DbClient,
  pageId: string,
): Promise<PublishedPageSnapshot | null> {
  const { rows } = await db<SnapshotQueryRow>`
    select data_rows.id as row_id,
           site_snapshots.site_json,
           data_row_versions.runtime_assets_json,
           site_snapshots.importmap_body,
           site_snapshots.importmap_sha256
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    join site_snapshots on site_snapshots.id = data_row_versions.site_snapshot_id
    where data_rows.id = ${pageId}
      and data_rows.table_id = 'pages'
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
    limit 1
  `
  return rows[0] ? snapshotFromQueryRow(rows[0]) : null
}

export async function getLatestPublishedSiteSnapshot(
  db: DbClient,
): Promise<PublishedPageSnapshot | null> {
  const { rows } = await db<SnapshotQueryRow>`
    select data_rows.id as row_id,
           site_snapshots.site_json,
           data_row_versions.runtime_assets_json,
           site_snapshots.importmap_body,
           site_snapshots.importmap_sha256
    from data_rows
    join data_row_versions on data_row_versions.id = data_rows.active_version_id
    join site_snapshots on site_snapshots.id = data_row_versions.site_snapshot_id
    where data_rows.table_id = 'pages'
      and data_rows.status = 'published'
      and data_rows.deleted_at is null
    order by data_rows.created_at asc
    limit 1
  `
  return rows[0] ? snapshotFromQueryRow(rows[0]) : null
}
