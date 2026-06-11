/**
 * Publish pipeline repository.
 *
 * Pages are stored in `data_rows` (table_id = 'pages'). A full publish
 * stores the published `SiteDocument` ONCE in `site_snapshots` (with a
 * content hash and the pre-serialised runtime importmap); each published
 * page version is a row in `data_row_versions` that references it via
 * `site_snapshot_id` and carries only its page-scoped `runtime_assets_json`.
 * Readers reassemble the `PublishedPageSnapshot` shape from the join, so
 * publishing N pages stores the site document once instead of N times.
 *
 * Public API:
 *   publishDraftSite          — build + store snapshots for all draft pages
 *   getPublishedPageBySlug    — look up a published page snapshot by slug
 *   getLatestPublishedSiteSnapshot — first published page snapshot (for 404s etc.)
 *   getDraftPublishStatus     — compare draft vs published state for the UI
 */
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import type { PublishedRuntimePackageImportmap, SiteCssBundle } from '@core/publisher'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { registry } from '@core/module-engine'
import type { DbClient } from '../db/client'
import { getDraftSite } from './site'
import { listDataRows, nextDataRowVersionNumber } from './data'
import { pageFromRow } from '../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../src/core/data/componentFromRow'
import { validateVisualComponents } from '../../src/core/persistence/validate'
import { buildSiteRuntimeScripts } from '../publish/runtime/bundleScripts'
import { ensureRuntimeDependencyCache } from '../publish/runtime/dependencyCache'
import {
  buildRuntimePackageImportmap,
  serializeImportmapForCsp,
} from '../publish/runtime/packageImportmap'
import { savePublishedRuntimeAssets } from './runtimeAsset'
import { renderPublishedSnapshot } from '../publish/publicRenderer'
import { isTemplatePage } from '@core/templates'
import { applyPublishedHtmlPipeline } from '../publish/publishedHtmlPipeline'
import { prepareInactiveSlot, writeArtefact, writeStaticAsset, swapSlot } from '../publish/staticArtefact'
import { buildPublishedSiteCssBundle } from '../publish/siteCssBundle'
import { bakePublishedDataRowArtefacts } from '../publish/bakeDataRows'
import { bumpPublishVersion, getPublishVersion, withPublishLock } from '../publish/publishState'

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

interface PublishResult {
  publishedPages: number
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
 * Assemble the in-memory snapshot for one page. The `site` object is SHARED
 * across every snapshot of a publish (it is frozen content — nothing mutates
 * it after creation), so building N snapshots costs N small objects, not N
 * deep clones of the whole site.
 */
function createSnapshot(
  site: SiteDocument,
  pageRowId: string,
  runtimeAssets?: PublishedPageRuntimeAssets,
  runtimePackageImportmap?: PublishedRuntimePackageImportmap,
): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageRowId,
    site,
    ...(runtimeAssets && runtimeAssets.scripts.length > 0 ? { runtimeAssets } : {}),
    ...(runtimePackageImportmap ? { runtimePackageImportmap } : {}),
  }
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

export async function getDraftPublishStatus(db: DbClient): Promise<DraftPublishStatus> {
  const shell = await getDraftSite(db)
  if (!shell) {
    return {
      hasPublishedVersion: false,
      draftMatchesPublished: false,
      draftPages: 0,
      publishedPages: 0,
    }
  }

  const [pageRows, vcRows] = await Promise.all([
    listDataRows(db, 'pages'),
    listDataRows(db, 'components'),
  ])
  const visualComponents = validateVisualComponents(
    vcRows.flatMap((r) => { const vc = visualComponentFromRow(r); return vc ? [vc] : [] })
  )
  const draftSite: SiteDocument = {
    ...shell,
    pages: pageRows.map(pageFromRow),
    visualComponents,
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

export async function publishDraftSite(
  db: DbClient,
  adminUserId: string,
  uploadsDir?: string,
): Promise<PublishResult> {
  // Serialize against every other publish so the version read→bake→bump window
  // can't interleave and mis-stamp baked hole shells (ISS-038).
  return withPublishLock(() => publishDraftSiteLocked(db, adminUserId, uploadsDir))
}

async function publishDraftSiteLocked(
  db: DbClient,
  adminUserId: string,
  uploadsDir?: string,
): Promise<PublishResult> {
  const { publishedPages, snapshots, runtimeAssetFiles } = await db.transaction(async (tx) => {
    const shell = await getDraftSite(tx)
    if (!shell) throw new Error('draft site not found')

    const [pageRows, vcRows] = await Promise.all([
      listDataRows(tx, 'pages'),
      listDataRows(tx, 'components'),
    ])
    const pages = pageRows.map(pageFromRow)
    const visualComponents = validateVisualComponents(
      vcRows.flatMap((r) => { const vc = visualComponentFromRow(r); return vc ? [vc] : [] })
    )
    const site: SiteDocument = { ...shell, pages, visualComponents }

    const runtime = normalizeSiteRuntimeConfig(site.runtime)
    const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
      ? await ensureRuntimeDependencyCache(runtime.dependencyLock)
      : undefined
    // Build the package importmap once per publish — the JSON is identical
    // for every page sharing the same lock, so its SHA-256 stays stable
    // across snapshots. Module plugins use bare imports (`import "three"`)
    // and the browser resolves them through this map at page load.
    const packageImportmap = dependencyCache
      ? await buildRuntimePackageImportmap(runtime.dependencyLock, dependencyCache)
      : null
    const serializedImportmap = packageImportmap
      ? await serializeImportmapForCsp(packageImportmap.importmap)
      : null
    const runtimePackageImportmap: PublishedRuntimePackageImportmap | undefined = serializedImportmap
      ? { body: serializedImportmap.body, sha256: serializedImportmap.sha256 }
      : undefined

    const publishedSite: SiteDocument = {
      ...site,
      pages: site.pages.map((page) => ({
        ...page,
        updatedByUserId: adminUserId,
      })),
    }

    // The site document is stored ONCE per publish; every page version row
    // references it. The content hash powers the publish-status check without
    // ever re-fetching the document.
    const siteSnapshotId = nanoid()
    await tx`
      insert into site_snapshots (id, site_json, content_hash, importmap_body, importmap_sha256)
      values (
        ${siteSnapshotId},
        ${publishedSite},
        ${siteContentHash(publishedSite)},
        ${serializedImportmap?.body ?? null},
        ${serializedImportmap?.sha256 ?? null}
      )
    `

    const snapshots: PublishedPageSnapshot[] = []
    // Runtime JS bytes for every page, collected for the Layer A disk write so
    // published pages serve their scripts straight off disk (not the DB).
    const runtimeAssetFiles: Array<{ publicPath: string; bytes: Uint8Array }> = []
    for (const page of publishedSite.pages) {
      const version = await nextDataRowVersionNumber(tx, page.id)
      const versionId = nanoid()
      const runtimeBuild = await buildSiteRuntimeScripts({
        site: publishedSite,
        page,
        target: 'publish',
        assetBasePath: `/_instatic/assets/${versionId}/`,
        dependencyCache,
      })
      const runtimeErrors = runtimeBuild.diagnostics.filter((d) => d.severity === 'error')
      if (runtimeErrors.length > 0) {
        throw new Error(`runtime build failed: ${runtimeErrors.map((d) => d.message).join('; ')}`)
      }

      const snapshot = createSnapshot(
        publishedSite,
        page.id,
        runtimeBuild.runtimeAssets,
        runtimePackageImportmap,
      )
      snapshots.push(snapshot)

      await tx`
        insert into data_row_versions
          (id, row_id, version_number, cells_json, slug, site_snapshot_id, runtime_assets_json, published_by_user_id)
        values (
          ${versionId},
          ${page.id},
          ${version},
          ${{ title: page.title, slug: page.slug }},
          ${page.slug},
          ${siteSnapshotId},
          ${snapshot.runtimeAssets ?? null},
          ${adminUserId}
        )
      `
      await savePublishedRuntimeAssets(tx, versionId, runtimeBuild.files)
      for (const file of runtimeBuild.files) {
        runtimeAssetFiles.push({ publicPath: file.publicPath, bytes: file.bytes })
      }
      await tx`
        update data_rows
        set active_version_id = ${versionId},
            status = 'published',
            published_by_user_id = ${adminUserId},
            published_at = current_timestamp,
            updated_by_user_id = ${adminUserId},
            updated_at = current_timestamp
        where id = ${page.id}
          and deleted_at is null
      `
    }

    return { publishedPages: publishedSite.pages.length, snapshots, runtimeAssetFiles }
  })

  // Layer A: write static artefacts outside the transaction. Disk artefacts
  // are derived state — a write failure is logged but does not roll back the
  // DB publish. Visitors fall through to the live renderer until the next
  // full publish rebuilds the slot.
  //
  // Complete static publishing: alongside each page's HTML we bake the CSS
  // bundles and runtime JS into the same slot under their public paths
  // (`/_instatic/css/...`, `/_instatic/assets/...`). The visitor router serves these off
  // disk, so a published page never hits the server to (re)generate its CSS
  // or JS — the slot is a self-contained static export.
  //
  // EVERY page is baked: fully-static pages bake to a complete document; pages
  // with dynamic nodes bake their static SHELL with `<instatic-hole>` placeholders
  // (the hole runtime lazy-fetches each fragment from `/_instatic/hole/`). Either way
  // the HTML + CSS + JS are served from disk — only the hole fragment touches
  // the server. The shells are stamped with `nextPublishVersion` (the version
  // that becomes current the instant `bumpPublishVersion()` runs after the
  // swap) so their `<instatic-hole data-instatic-version>` matches what the hole endpoint
  // expects; otherwise every baked hole would be rejected as stale.
  const nextPublishVersion = getPublishVersion() + 1
  if (uploadsDir) {
    try {
      const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)

      // Every distinct static asset referenced by ANY baked artefact.
      // Content-hashed filenames dedupe identical bytes across pages to a
      // single write. The page-invariant CSS trio (reset/framework/style) is
      // computed ONCE per publish via the version-keyed memo — the all-pages
      // walk no longer repeats per page. Only `userStyles` is page-scoped.
      const assetsByPath = new Map<string, Uint8Array>()
      const encoder = new TextEncoder()
      const collectCssFiles = (cssBundle: SiteCssBundle): void => {
        for (const file of [cssBundle.reset, cssBundle.framework, cssBundle.style, cssBundle.userStyles]) {
          if (file.content.length === 0) continue
          const publicPath = `/_instatic/css/${file.filename}`
          if (!assetsByPath.has(publicPath)) assetsByPath.set(publicPath, encoder.encode(file.content))
        }
      }
      for (const snapshot of snapshots) {
        const page = snapshot.site.pages.find((p) => p.id === snapshot.pageRowId)
        if (!page || isTemplatePage(page)) continue // template pages only ever wrap; never baked at their own slug
        collectCssFiles(buildPublishedSiteCssBundle(snapshot.site, registry, page, nextPublishVersion))
      }
      for (const asset of runtimeAssetFiles) {
        if (!assetsByPath.has(asset.publicPath)) assetsByPath.set(asset.publicPath, asset.bytes)
      }

      // HTML artefacts (or hole shells) for every page. A page that fails to
      // render (e.g. a VC ref cycle) is skipped and falls through to the live
      // renderer at request time — one bad page never aborts the whole bake.
      for (const snapshot of snapshots) {
        const page = snapshot.site.pages.find((p) => p.id === snapshot.pageRowId)
        if (!page || isTemplatePage(page)) continue // template pages only ever wrap; never baked at their own slug
        const urlPath = page.slug === 'index' ? '/' : `/${page.slug}`
        try {
          const syntheticUrl = new URL(`http://localhost${urlPath}`)
          const rendered = await renderPublishedSnapshot(snapshot, {
            db,
            url: syntheticUrl,
            publishVersion: nextPublishVersion,
          })
          const html = await applyPublishedHtmlPipeline(rendered, db)
          await writeArtefact(slotDir, urlPath, html)
          // The render's own bundle covers template-composed hashes the raw
          // page bundle above cannot (the merged page's userStyles).
          collectCssFiles(rendered.cssBundle)
        } catch (err) {
          console.error('[publish:site] failed to bake artefact for', urlPath, '(falls through to live renderer):', err)
        }
      }

      // Data-row artefacts: every published row whose table has an entry
      // template bakes into the same slot. Without this the slot swap would
      // strand every previously-baked row artefact in the inactive slot and
      // ALL row routes would fall to the live renderer after a full publish.
      const rowBake = await bakePublishedDataRowArtefacts(db, slotDir, nextPublishVersion)
      for (const cssBundle of rowBake.cssBundles) collectCssFiles(cssBundle)

      for (const [publicPath, bytes] of assetsByPath) {
        await writeStaticAsset(slotDir, publicPath, bytes)
      }
      await swapSlot(uploadsDir, slot)
    } catch (err) {
      console.error('[publish:site] static artefact write failed (live renderer remains active):', err)
    }
  }

  // Layer B: invalidate the in-memory render cache so the next visitor request
  // re-renders against the freshly committed snapshot. This is the SYNCHRONOUS
  // statement right after the swap — no `await` between them — so there is no
  // window where the freshly-swapped shells (stamped nextPublishVersion) are
  // live while the version counter still reads the old value.
  bumpPublishVersion()

  return { publishedPages }
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

// `listPluginPageSummaries` was removed alongside the `api.cms.pages.*`
// surface. The generic `listDataRowsWithFilter` in
// `server/repositories/data/rows.ts` covers the same use case (filter by
// table + status) and works for every content table — not just `pages`.
