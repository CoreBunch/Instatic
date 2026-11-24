import '../../src/modules/base'
import '@core/loops/sources'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { buildPageFrame, buildRouteFrame } from '@core/templates/contextFrames'
import { buildPublishedSiteCssBundle } from './siteCssBundle'
import { buildPublishedSiteModuleJsMap, resolveModuleScripts } from './moduleJsBundle'
import type { ModuleScriptRef } from './moduleJsBundle'
import { HOLE_RUNTIME_VERSION } from './holeRuntime'
import { LOOP_RUNTIME_VERSION } from './loopRuntime'
import { resolveTemplateChain, resolveNotFoundTemplate, composeTemplateChain } from '@core/templates'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { pendingAppRequestOnPage, stampAppRequestId } from '../members/apps/approval'
import { closedContentFor, getAccessIndex, memberFrameFor } from './accessGate'
import type { CurrentMember } from '@core/members'
import { prefetchLoopData, publishedDataRowToEntryItem } from './loopPrefetch'
import { prefetchMediaAssets } from './mediaPrefetch'
import { getPublishVersion } from './publishState'
import { getPublishedSnapshotHash } from './publishedSnapshotCache'
import type { Page } from '@core/page-tree'
import type { DocumentMetaOverride, SiteCssBundle } from '@core/publisher'
import type { PublishedDataRow } from '@core/data/schemas'
import { readEntrySeoOverride } from '@core/data/cells'
import type { DbClient } from '../db/client'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { getDataTable } from '../repositories/data'
import { MAIN_SCOPE } from '../branches/scope'

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
   * The module scripts this page must load, each with the content hash of
   * its body (see `resolveModuleScripts`), so `injectModuleScripts` can emit
   * tags without any further lookup.
   */
  moduleScripts: ModuleScriptRef[]
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
  /** Cache generation used for the CSS bundle memo and the access index during the bake. */
  publishVersion?: number
  /**
   * The visitor this render is for, on a protected route: the member, or
   * null when signed out. Absent means the render is for nobody in
   * particular, which is every baked and every shared-cache render: lists
   * then leave out whatever a signed-out visitor may not open, and anything
   * that depends on the member is deferred to a per-visitor fragment.
   */
  approval?: TemplateRenderDataContext['approval']
  visitor?: CurrentMember | null
}

/**
 * Shared render tail for both public paths. Given an already-resolved,
 * composed `merged` tree and its seed `templateContext`, this owns the
 * identical CSS-bundle build + loop/media prefetch + `publishPage` call +
 * module-script resolution. The two public functions differ only in how they
 * resolve the chain and seed the context, plus which `pageId`/`slug` they
 * report — so any new `publishPage` option threads through here once.
 */
async function renderMergedTemplate(
  merged: Page,
  snapshot: PublishedPageSnapshot,
  templateContext: TemplateRenderDataContext | undefined,
  ctx: RenderPublishedSnapshotContext,
  documentMeta?: DocumentMetaOverride,
): Promise<{ html: string; moduleScripts: ModuleScriptRef[]; cssBundle: SiteCssBundle }> {
  const publishVersion = ctx.publishVersion ?? getPublishVersion()
  const moduleJsMap = buildPublishedSiteModuleJsMap(snapshot.site, registry)
  // The index for the version being rendered: during a publish that is the
  // NEXT version, loaded after the publish committed, so a page protected by
  // this very publish is already left out of the lists being baked.
  const closed = closedContentFor(await getAccessIndex(ctx.db, publishVersion), ctx.visitor?.tags ?? null)
  const loopData = await prefetchLoopData(merged, snapshot.site, ctx.db, ctx.url, { closed })
  const mediaAssets = await prefetchMediaAssets(merged, snapshot.site, registry, ctx.db, {
    templateContext,
    loopData,
  })
  const cssBundle = buildPublishedSiteCssBundle(snapshot.site, registry, merged, publishVersion, { mediaAssets })
  // A render for one visitor carries the member, so member bindings and
  // show-when rules resolve in place instead of becoming fragments.
  const appRequest = ctx.visitor && !ctx.approval ? await pendingAppRequestOnPage(ctx.db, ctx.url) : null
  const visitorContext: TemplateRenderDataContext | undefined =
    ctx.visitor === undefined
      ? templateContext
      : {
          ...(templateContext ?? { entryStack: [] }),
          approval: ctx.approval,
          member: memberFrameFor(ctx.visitor, appRequest?.frame ?? null),
        }
  const published = publishPage(merged, snapshot.site, registry, {
    templateContext: visitorContext,
    ...(documentMeta ? { documentMeta } : {}),
    runtimeAssets: snapshot.runtimeAssets,
    runtimePackageImportmap: snapshot.runtimePackageImportmap,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    mediaAssets,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
    snapshotHash: getPublishedSnapshotHash(snapshot.site),
    holeRuntimeVersion: HOLE_RUNTIME_VERSION,
    loopRuntimeVersion: LOOP_RUNTIME_VERSION,
  })
  // Per-page injection set = candidates from the render (emitted ∪ hole
  // subtrees) ∩ the site module-JS map — over-inclusive candidates from
  // unbaked holes are filtered down to modules that actually ship JS.
  const moduleScripts = resolveModuleScripts(published.jsModuleIds, moduleJsMap)
  // The approval form of a page opened with a waiting request posts it back
  // even with scripts off.
  const html = appRequest ? stampAppRequestId(published.html, appRequest.requestId) : published.html
  return { html, moduleScripts, cssBundle }
}

/** The binding frames for a page render: the served page itself, and the request route when known. */
function pageTemplateContext(page: Page, url: URL | undefined): TemplateRenderDataContext {
  return { entryStack: [], page: buildPageFrame(page), ...(url ? { route: buildRouteFrame(url.toString()) } : {}) }
}

export async function renderPublishedSnapshot(
  snapshot: PublishedPageSnapshot,
  ctx: RenderPublishedSnapshotContext,
): Promise<RendererOutput> {
  const page = snapshot.site.pages.find((candidate) => candidate.id === snapshot.pageRowId)
  if (!page) throw new Error(`Published page "${snapshot.pageRowId}" not found in snapshot`)

  // Wrap the page in any matching layout templates (everywhere → …), producing
  // one merged tree so the existing publish pipeline runs in a single pass.
  const chain = resolveTemplateChain(snapshot.site, { kind: 'page' })
  const merged = composeTemplateChain(chain, { kind: 'page', page })

  // `{page.*}` names the page being served, not the layout the composed tree
  // is keyed by (composeTemplateChain keeps the innermost template's id and
  // slug for the publish.html filter). Seed the route frame from the actual
  // request URL (when available) so `{route.slug}` / `{route.path}` resolve
  // to live values; without one publishPage falls back to the page permalink.
  const templateContext = pageTemplateContext(page, ctx.url)

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

  const chain = resolveTemplateChain(snapshot.site, { kind: 'page' })
  const merged = composeTemplateChain(chain, { kind: 'page', page })

  const templateContext = pageTemplateContext(page, ctx.url)

  const rendered = await renderMergedTemplate(merged, snapshot, templateContext, ctx)
  return { ...rendered, pageId: page.id, slug: page.slug, siteId: snapshot.site.id }
}

export async function renderPublishedDataRowTemplate(
  snapshot: PublishedPageSnapshot,
  row: PublishedDataRow,
  ctx: RenderPublishedSnapshotContext,
): Promise<RendererOutput | null> {
  // Build the full chain (everywhere layout + entry template) and merge it into
  // one tree; the innermost outlet renders the current entry's body.
  const chain = resolveTemplateChain(snapshot.site, { kind: 'entry', tableSlug: row.tableSlug })
  if (chain.length === 0) return null // no entry template → 404 (unchanged behaviour)
  const merged = composeTemplateChain(chain, { kind: 'entry' })
  // The template chain has no Page for the entry, so composeTemplateChain
  // can't know its title — the entry's own title is the real page title.
  // It stays the plain `title` cell: `page.title` feeds the `{page.title}`
  // binding as well as `<title>`, so the SEO override travels separately
  // through `documentMeta` and only reaches the `<head>`.
  if (typeof row.cells.title === 'string') merged.title = row.cells.title

  const table = await getDataTable(ctx.db, MAIN_SCOPE, row.tableId)

  // Seed the entry stack with the published row + route frame from the request
  // URL. Loop interceptors push/pop iteration items on top of this stack;
  // nodes outside any loop resolve their `currentEntry` bindings against this
  // seed. page/site/viewer frames are filled by `publishPage` from the document.
  const templateContext: TemplateRenderDataContext = {
    entryStack: [await publishedDataRowToEntryItem(ctx.db, row, table?.fields ?? [])],
    ...(ctx.url ? { route: buildRouteFrame(ctx.url.toString()) } : {}),
  }

  const rendered = await renderMergedTemplate(
    merged,
    snapshot,
    templateContext,
    ctx,
    readEntrySeoOverride(row.cells),
  )
  return { ...rendered, pageId: merged.id, slug: merged.slug, siteId: snapshot.site.id }
}
