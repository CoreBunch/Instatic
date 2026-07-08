/**
 * Full-site publish orchestrator.
 *
 * Drives the whole publish pipeline for the current draft site:
 *
 *   Phase 1 — read the draft + run every expensive non-DB build (runtime
 *             script bundling, dependency cache, package importmap).
 *   Phase 2 — one short DB transaction via `persistSitePublish` (the
 *             publish repository owns all SQL).
 *   Layer A — bake static artefacts (HTML + CSS + runtime JS) into the
 *             inactive slot and swap it live (`staticArtefact.ts`).
 *   Layer B — bump the publish version so the in-memory render cache and
 *             the version-keyed snapshot memos refresh.
 *
 * Data access lives in `server/repositories/publish.ts`; this module owns
 * the sequencing, rendering, and disk artefacts. The dependency direction is
 * one-way: publish → repositories, never back.
 */
import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import type { PublishedRuntimePackageImportmap, SiteCssBundle } from '@core/publisher'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { registry } from '@core/module-engine'
import { isTemplatePage, resolveNotFoundTemplate } from '@core/templates'
import type { DbClient } from '../db/client'
import { nextDataRowVersionNumber } from '../repositories/data'
import {
  getDraftSiteDocument,
  persistSitePublish,
  type PublishedPageSnapshot,
  type PublishedPageVersionWrite,
} from '../repositories/publish'
import { buildSiteRuntimeScripts } from './runtime/bundleScripts'
import { ensureRuntimeDependencyCache } from './runtime/dependencyCache'
import {
  buildRuntimePackageImportmap,
  serializeImportmapForCsp,
} from './runtime/packageImportmap'
import { renderPublishedNotFound, renderPublishedSnapshot } from './publicRenderer'
import { prefetchMediaAssets } from './mediaPrefetch'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'
import {
  NOT_FOUND_ARTEFACT_URL_PATH,
  prepareInactiveSlot,
  swapSlot,
  writeArtefact,
  writeStaticAsset,
} from './staticArtefact'
import { buildPublishedSiteCssBundle } from './siteCssBundle'
import { bakePublishedDataRowArtefacts } from './bakeDataRows'
import { bumpPublishVersion, getPublishVersion, withPublishLock } from './publishState'

interface PublishResult {
  publishedPages: number
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
  // ── Phase 1: read inputs + run every expensive non-DB build ──────────────
  // Dependency installs (`bun install` on a cold cache) and per-page esbuild
  // runs take seconds; the SQLite adapter serializes ALL transactions through
  // one chain, so doing this inside the transaction stalled every concurrent
  // write (autosaves, row publishes) behind it. `withPublishLock` already
  // serializes publishes, and version numbers are only allocated by publish
  // paths under that same lock, so reading outside the transaction is stable.
  const site = await getDraftSiteDocument(db)
  if (!site) throw new Error('draft site not found')

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

  const siteSnapshotId = nanoid()
  const snapshots: PublishedPageSnapshot[] = []
  // Runtime JS bytes for every page, collected for the Layer A disk write so
  // published pages serve their scripts straight off disk (not the DB).
  const runtimeAssetFiles: Array<{ publicPath: string; bytes: Uint8Array }> = []
  const pageWrites: PublishedPageVersionWrite[] = []
  for (const page of publishedSite.pages) {
    const versionNumber = await nextDataRowVersionNumber(db, page.id)
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
    pageWrites.push({
      pageId: page.id,
      title: page.title,
      slug: page.slug,
      versionId,
      versionNumber,
      runtimeAssets: snapshot.runtimeAssets ?? null,
      runtimeFiles: runtimeBuild.files,
    })
    for (const file of runtimeBuild.files) {
      runtimeAssetFiles.push({ publicPath: file.publicPath, bytes: file.bytes })
    }
  }

  // ── Phase 2: short transaction — DB writes only ───────────────────────────
  await persistSitePublish(db, {
    siteSnapshotId,
    site: publishedSite,
    serializedImportmap: serializedImportmap
      ? { body: serializedImportmap.body, sha256: serializedImportmap.sha256 }
      : null,
    pages: pageWrites,
    publishedByUserId: adminUserId,
  })

  const publishedPages = publishedSite.pages.length

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
        const mediaAssets = await prefetchMediaAssets(page, snapshot.site, registry, db)
        collectCssFiles(buildPublishedSiteCssBundle(snapshot.site, registry, page, nextPublishVersion, { mediaAssets }))
      }
      for (const asset of runtimeAssetFiles) {
        if (!assetsByPath.has(asset.publicPath)) assetsByPath.set(asset.publicPath, asset.bytes)
      }

      // The 404 page: bake the notFound template (wrapped in its everywhere
      // layout chain) to `404.html`. Baked FIRST so a literal page with slug
      // `404` — if anyone creates one — overwrites it below and stays
      // authoritative for both `/404` and the static-export error page.
      const notFoundPage = resolveNotFoundTemplate(publishedSite)
      const notFoundSnapshot = notFoundPage
        ? snapshots.find((s) => s.pageRowId === notFoundPage.id)
        : undefined
      if (notFoundSnapshot) {
        try {
          const rendered = await renderPublishedNotFound(notFoundSnapshot, {
            db,
            url: new URL(`http://localhost${NOT_FOUND_ARTEFACT_URL_PATH}`),
            publishVersion: nextPublishVersion,
          })
          if (rendered) {
            const html = await applyPublishedHtmlPipeline(rendered, db)
            await writeArtefact(slotDir, NOT_FOUND_ARTEFACT_URL_PATH, html)
            collectCssFiles(rendered.cssBundle)
          }
        } catch (err) {
          console.error('[publish:site] failed to bake the 404 artefact (falls through to live renderer):', err)
        }
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
