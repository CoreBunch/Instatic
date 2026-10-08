/**
 * Full-site publish orchestrator.
 *
 * Drives the whole publish pipeline for the current draft site:
 *
 *   Phase 1 — read the draft + run every expensive non-DB build (runtime
 *             script bundling, dependency cache, package importmap).
 *   Layer A — stage static artefacts (HTML + CSS + runtime JS + files) in
 *             the inactive slot before any snapshot write.
 *   Phase 2 — one short DB transaction via `persistSitePublish` (the
 *             publish repository owns all SQL), activating the slot before commit.
 *   Layer B — bump the publish version so the in-memory render cache and
 *             the version-keyed snapshot memos refresh.
 *
 * Data access lives in `server/repositories/publish.ts`; this module owns
 * the sequencing, rendering, and disk artefacts. The dependency direction is
 * one-way: publish → repositories, never back.
 */
import { nanoid } from 'nanoid'
import type { SiteDocument } from '@core/page-tree'
import { assertSiteForms } from '@core/forms'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import type { PublishedRuntimePackageImportmap, SiteCssBundle } from '@core/publisher'
import { assertSitePublicFileBindings, assertSiteTranslations } from '@core/publisher'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { registry } from '@core/module-engine'
import { isTemplatePage, resolveNotFoundTemplate, resolveTemplateChain } from '@core/templates'
import type { DbClient } from '../db/client'
import { nextDataRowVersionNumber } from '../repositories/data'
import {
  getDraftSiteDocument,
  persistSitePublish,
  type PublishedPageSnapshot,
  type PublishedPageVersionWrite,
} from '../repositories/publish'
import { buildSiteRuntimeScripts } from './runtime/bundleScripts'
import { RuntimeScriptBuildError } from './runtime/buildError'
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
  getActiveSlot,
  prepareInactiveSlot,
  swapSlot,
  writeArtefact,
  writeStaticAsset,
} from './staticArtefact'
import { buildPublishedSiteCssBundle } from './siteCssBundle'
import { bakePublishedDataRowArtefacts } from './bakeDataRows'
import { beginPublishActivation, bumpPublishVersion, clearPublishSnapshotCaches, getPublishVersion, withPublishLock } from './publishState'
import { runPublishFlush } from './publishFlush'
import { sweepStalePluginVersionAssets } from './stalePluginAssets'
import { MAIN_SCOPE } from '../branches/scope'
import { pagePublicPath } from '@core/page-tree'
import { listPublishedRowRoutes, publicDataPath } from '../repositories/data/publish'
import { compilePublicSiteAssets, writePublicSiteAssets } from './publicSiteAssets'

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
  // Flush the collab relay so the published snapshot includes edits still
  // inside the debounce window (publish bakes exactly what the admins see).
  // Intrinsic to publishing now, not bolted onto the HTTP route.
  await runPublishFlush()
  // Serialize against every other publish so the version read→bake→bump window
  // can't interleave and mis-stamp baked hole shells (ISS-038).
  return withPublishLock(async () => {
    try {
      return await publishDraftSiteLocked(db, adminUserId, uploadsDir)
    } catch (error) {
      // A failed bake may have primed next-version CSS/snapshot memos. A
      // following row publish can use that version, so discard those values.
      clearPublishSnapshotCaches()
      throw error
    }
  })
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
  const site = await getDraftSiteDocument(db, MAIN_SCOPE)
  if (!site) throw new Error('draft site not found')
  assertSiteForms(site)
  assertSiteTranslations(site)

  const contentRoutes = site.files.some((file) => file.type === 'asset')
    ? await listPublishedRowRoutes(db)
    : []
  const publicAssets = compilePublicSiteAssets(site.files, [
    ...site.pages.filter((page) => !isTemplatePage(page)).map((page) => pagePublicPath(page.slug)),
    ...contentRoutes.filter((route) => resolveTemplateChain(site, { kind: 'entry', tableSlug: route.tableSlug }).length > 0)
      .map((route) => publicDataPath(route.tableRouteBase, route.rowSlug)),
  ])
  if (publicAssets.length > 0 && !uploadsDir) throw new Error('Public site assets require the configured uploads directory')
  assertSitePublicFileBindings(site)

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
      throw new RuntimeScriptBuildError(page, runtimeErrors)
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

  // Layer A: stage the complete generation BEFORE committing any snapshot.
  // Every render, pipeline and I/O failure aborts publication, leaving the
  // active slot, snapshot and version intact. Validate the complete generation
  // even when the caller does not request disk artefacts.
  //
  // Complete static publishing: alongside each page's HTML we bake the CSS
  // bundles and runtime JS into the same slot under their public paths
  // (`/_instatic/css/...`, `/_instatic/assets/...`). The visitor router serves these off
  // disk, so a published page never hits the server to (re)generate its CSS
  // or JS — the slot is a self-contained static export. The one thing it
  // references from outside is plugin frontend assets
  // (`/uploads/plugins/<id>/<version>/…`), which is why the stale-version
  // sweep below runs only after a publish has rewritten those links.
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
  const preparedSlot = uploadsDir ? await prepareInactiveSlot(uploadsDir) : undefined
  const slotDir = preparedSlot?.slotDir

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
    const rendered = await renderPublishedNotFound(notFoundSnapshot, {
      db,
      url: new URL(`http://localhost${NOT_FOUND_ARTEFACT_URL_PATH}`),
      publishVersion: nextPublishVersion,
    })
    if (!rendered) throw new Error('The prepared not-found template did not render')
    const html = await applyPublishedHtmlPipeline(rendered, db)
    if (slotDir) await writeArtefact(slotDir, NOT_FOUND_ARTEFACT_URL_PATH, html)
    collectCssFiles(rendered.cssBundle)
  }

  // HTML artefacts (or hole shells) for every routable page. Render failures
  // propagate before the publication transaction can change the active site.
  for (const snapshot of snapshots) {
    const page = snapshot.site.pages.find((p) => p.id === snapshot.pageRowId)
    if (!page || isTemplatePage(page)) continue // template pages only ever wrap; never baked at their own slug
    const urlPath = page.slug === 'index' ? '/' : `/${page.slug}`
    const syntheticUrl = new URL(`http://localhost${urlPath}`)
    const rendered = await renderPublishedSnapshot(snapshot, {
      db,
      url: syntheticUrl,
      publishVersion: nextPublishVersion,
    })
    const html = await applyPublishedHtmlPipeline(rendered, db)
    if (slotDir) await writeArtefact(slotDir, urlPath, html)
    // The render's own bundle covers template-composed hashes the raw
    // page bundle above cannot (the merged page's userStyles).
    collectCssFiles(rendered.cssBundle)
  }

  // Data-row artefacts: every published row whose table has an entry
  // template bakes into the same slot. Without this the slot swap would
  // strand every previously-baked row artefact in the inactive slot and
  // ALL row routes would fall to the live renderer after a full publish.
  const rowBake = await bakePublishedDataRowArtefacts(db, slotDir, nextPublishVersion, snapshots)
  for (const cssBundle of rowBake.cssBundles) collectCssFiles(cssBundle)

  if (slotDir) {
    for (const [publicPath, bytes] of assetsByPath) {
      await writeStaticAsset(slotDir, publicPath, bytes)
    }
    await writePublicSiteAssets(slotDir, publicAssets)
  }

  // ── Phase 2: short transaction + staged generation activation ─────────────
  const previousSlot = uploadsDir ? await getActiveSlot(uploadsDir) : undefined
  let activated = false
  let finishActivation: (() => void) | undefined
  try {
    await persistSitePublish(db, {
      siteSnapshotId,
      site: publishedSite,
      serializedImportmap: serializedImportmap
        ? { body: serializedImportmap.body, sha256: serializedImportmap.sha256 }
        : null,
      pages: pageWrites,
      publishedByUserId: adminUserId,
    }, async () => {
      if (!uploadsDir || !preparedSlot) return
      finishActivation = beginPublishActivation()
      await swapSlot(uploadsDir, preparedSlot.slot)
      activated = true
    })
    bumpPublishVersion()
  } catch (error) {
    // A commit can fail after its final activation callback. Restore the old
    // pointer while visitor reads are still held behind the same barrier.
    if (activated && uploadsDir && previousSlot) {
      try {
        await swapSlot(uploadsDir, previousSlot)
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Publication failed and its previous pointer could not be restored', { cause: restoreError })
      }
    }
    throw error
  } finally {
    finishActivation?.()
  }

  if (uploadsDir) {
    // The artefacts just written link the CURRENTLY installed plugin versions,
    // so any older version's files are now referenced by nothing. This is the
    // only moment that is true — which is why an upgrade must not delete them
    // itself. Leftovers are wasted disk, never a broken page, so a failure
    // here is logged and the publish still succeeds.
    try {
      const { removed } = await sweepStalePluginVersionAssets(db, uploadsDir)
      if (removed > 0) console.warn(`[publish:site] retired ${removed} stale plugin version dir(s)`)
    } catch (err) {
      console.error('[publish:site] stale plugin asset sweep failed (harmless, retries next publish):', err)
    }
  }

  return { publishedPages: publishedSite.pages.length }
}
