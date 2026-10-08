import '../../src/modules/base'
import '@core/loops/sources'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { buildPublishedSiteCssBundle } from './siteCssBundle'
import { buildPublishedSiteModuleJsMap } from './moduleJsBundle'
import { resolveNotFoundTemplate } from '@core/templates'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { prefetchLoopData } from './loopPrefetch'
import { prefetchMediaAssets } from './mediaPrefetch'
import { getPublishVersion } from './publishState'
import type { Page } from '@core/page-tree'
import type { DocumentMetaOverride, SiteCssBundle } from '@core/publisher'
import type { PublishedDataRow } from '@core/data/schemas'
import { readEntrySeoOverride } from '@core/data/cells'
import type { DbClient } from '../db/client'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { buildPublishedPageRenderContext, buildPublishedEntryRenderContext } from './publishedRenderContext'

/**
 * URL prefix where the Bun server exposes the per-site CSS bundle. Mirrors
 * `/_instatic/assets/` for runtime scripts. The matching route is registered in
 * `server/router.ts` and serves files with `Cache-Control: immutable`.
 */
const CSS_ASSET_BASE_URL = '/_instatic/css/'

/** URL prefix for the loop data endpoint serving infinite-load fragments. */
const LOOP_ENDPOINT_BASE_URL = '/_instatic/loop/'

/**
 * Renderer output — raw HTML body without plugin asset injection or the
 * `publish.html` filter applied. Post-processing runs ONCE at the
 * dispatcher (see `applyPublishedHtmlPipeline` in `server/router.ts`) so
 * every HTML-emitting path — pages, post templates, and the fallback
 * standalone data-row document — goes through the same pipeline. Adding
 * a new HTML-emitting code path means wiring it into the dispatcher
 * pipeline, not duplicating injection logic.
 */
export interface RendererOutput {
  html: string
  /** Identifies what was rendered, for the publish.html filter context. */
  pageId: string
  slug: string
  siteId: string
  /**
   * Sorted moduleIds whose published JS this page must load — already
   * intersected with the site module-JS map, so `injectModuleScripts` can
   * emit tags without any further lookup.
   */
  jsModuleIds: string[]
  /**
   * Publish version this page was rendered at (the bake passes the NEXT
   * version, live renders the current one) — stamped into module-js `?v=`
   * URLs so they cache-bust in lockstep with hole placeholders.
   */
  publishVersion: number
  /**
   * The CSS bundle this render's HTML actually references (`<link href>`
   * hashes). The publish-time bake writes these exact files into the slot so
   * every baked artefact's CSS is on disk — including hashes that only exist
   * for template-composed renders (entry templates wrap rows in a merged page
   * whose page-scoped `userStyles` hash can differ from any raw page's).
   */
  cssBundle: SiteCssBundle
}

interface RenderPublishedSnapshotContext {
  db: DbClient
  /** Optional request URL — when present, drives per-loop pagination. */
  url?: URL
  /**
   * Publish version to stamp into `<instatic-hole data-instatic-version>` placeholders.
   * Defaults to the live `getPublishVersion()`. The full/incremental publish
   * bakes shells BEFORE bumping the version, so it passes the next version
   * (`getPublishVersion() + 1`) here — otherwise every baked hole would carry
   * a stale version and the hole endpoint would refuse to hydrate it.
   */
  publishVersion?: number
}

/**
 * Shared render tail for both public paths. Given an already-resolved,
 * composed `merged` tree and its seed `templateContext`, this owns the
 * identical CSS-bundle build + loop/media prefetch + `publishPage` call +
 * publish-version stamping. `publishedRenderContext.ts` supplies the same
 * composed trees and native frames for these full renders and loop fragments.
 */
async function renderMergedTemplate(
  merged: Page,
  snapshot: PublishedPageSnapshot,
  templateContext: TemplateRenderDataContext | undefined,
  ctx: RenderPublishedSnapshotContext,
  documentMeta?: DocumentMetaOverride,
): Promise<{ html: string; jsModuleIds: string[]; publishVersion: number; cssBundle: SiteCssBundle }> {
  const publishVersion = ctx.publishVersion ?? getPublishVersion()
  const moduleJsMap = buildPublishedSiteModuleJsMap(snapshot.site, registry)
  const loopData = await prefetchLoopData(merged, snapshot.site, ctx.db, ctx.url, { templateContext })
  const mediaAssets = await prefetchMediaAssets(merged, snapshot.site, registry, ctx.db, {
    templateContext,
    loopData,
  })
  const cssBundle = buildPublishedSiteCssBundle(snapshot.site, registry, merged, publishVersion, { mediaAssets, runtimeAssets: snapshot.runtimeAssets })
  const published = publishPage(merged, snapshot.site, registry, {
    templateContext,
    ...(documentMeta ? { documentMeta } : {}),
    runtimeAssets: snapshot.runtimeAssets,
    runtimePackageImportmap: snapshot.runtimePackageImportmap,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    mediaAssets,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
    publishVersion,
  })
  // Per-page injection set = candidates from the render (emitted ∪ hole
  // subtrees) ∩ the site module-JS map — over-inclusive candidates from
  // unbaked holes are filtered down to modules that actually ship JS.
  const jsModuleIds = published.jsModuleIds.filter((id) => moduleJsMap.has(id))
  return { html: published.html, jsModuleIds, publishVersion, cssBundle }
}

export async function renderPublishedSnapshot(
  snapshot: PublishedPageSnapshot,
  ctx: RenderPublishedSnapshotContext,
): Promise<RendererOutput> {
  const page = snapshot.site.pages.find((candidate) => candidate.id === snapshot.pageRowId)
  if (!page) throw new Error(`Published page "${snapshot.pageRowId}" not found in snapshot`)

  const { page: merged, templateContext } = buildPublishedPageRenderContext(snapshot, page, ctx.url)

  const rendered = await renderMergedTemplate(merged, snapshot, templateContext, ctx)
  return { ...rendered, pageId: snapshot.pageRowId, slug: page.slug, siteId: snapshot.site.id }
}

/**
 * Render the site's `notFound` template — the body of every public 404
 * response. Composed exactly like a regular page: wrapped by the matching
 * `everywhere` layout chain so the 404 page carries the site chrome. Returns
 * `null` when the published site doesn't define a notFound template (callers
 * fall back to the bare JSON 404).
 */
export async function renderPublishedNotFound(
  snapshot: PublishedPageSnapshot,
  ctx: RenderPublishedSnapshotContext,
): Promise<RendererOutput | null> {
  const page = resolveNotFoundTemplate(snapshot.site)
  if (!page) return null

  const { page: merged, templateContext } = buildPublishedPageRenderContext(snapshot, page, ctx.url)

  const rendered = await renderMergedTemplate(merged, snapshot, templateContext, ctx)
  return { ...rendered, pageId: page.id, slug: page.slug, siteId: snapshot.site.id }
}

export async function renderPublishedDataRowTemplate(
  snapshot: PublishedPageSnapshot,
  row: PublishedDataRow,
  ctx: RenderPublishedSnapshotContext,
): Promise<RendererOutput | null> {
  const context = buildPublishedEntryRenderContext(snapshot, row, ctx.url)
  if (!context) return null
  const { page: merged, templateContext } = context

  const rendered = await renderMergedTemplate(
    merged,
    snapshot,
    templateContext,
    ctx,
    readEntrySeoOverride(row.cells),
  )
  return { ...rendered, pageId: merged.id, slug: merged.slug, siteId: snapshot.site.id }
}
