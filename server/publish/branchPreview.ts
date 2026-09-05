/**
 * Branch preview rendering — the public site as a branch's DRAFT would show
 * it, for visitors carrying a valid preview cookie.
 *
 * Mirrors the editor's own runtime preview rather than the publish path: the
 * page (or entry template) is composed from the branch's draft rows, loops
 * read the branch, runtime scripts are bundled on demand and served from
 * memory, CSS is inlined, and no publish hook fires. Nothing here touches
 * the published snapshots, the render caches, or the disk slots — a preview
 * is a render, never a publish.
 *
 * Every response is `no-store` and `noindex`, and carries a banner naming
 * the branch with an exit link.
 */
import '../../src/modules/base'
import '@core/loops/sources'
import { createHash } from 'node:crypto'
import { registry } from '@core/module-engine'
import { escapeHtml } from '@core/html-sanitize'
import { publishPage, type PublishedRuntimePackageImportmap } from '@core/publisher'
import { composeTemplateChain, isTemplatePage, resolveTemplateChain } from '@core/templates'
import { buildRouteFrame } from '@core/templates/contextFrames'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { SourceRequestContext } from '@core/loops/types'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { readFeaturedMediaCell } from '@core/data/cells'
import type { DataRow, DataTable, PublishedDataRow } from '@core/data/schemas'
import type { Page, SiteDocument } from '@core/page-tree'
import { canonicalJson } from '@core/utils/canonicalJson'
import type { DbClient } from '../db/client'
import type { BranchScope } from '../branches/scope'
import { BRANCH_PREVIEW_EXIT_PATH } from '../branches/previewLinks'
import { getBranch } from '../repositories/branches'
import { getDataRowBySlug, listDataTables } from '../repositories/data'
import { getDraftSiteDocument } from '../repositories/publish'
import { collectFrontendInjections, injectFrontendAssets } from './frontendInjections'
import { prefetchLoopData, publishedDataRowToLoopItem } from './loopPrefetch'
import { prefetchMediaAssets } from './mediaPrefetch'
import { contentRouteFromPath, publicSlugFromPath } from './publicRouter'
import { getPublishVersion } from './publishState'
import { buildSiteRuntimeScripts } from './runtime/bundleScripts'
import { ensureRuntimeDependencyCache } from './runtime/dependencyCache'
import { buildRuntimePackageImportmap, serializeImportmapForCsp } from './runtime/packageImportmap'
import { hasPreviewBuild, previewAssetBasePath, rememberPreviewBuild } from './branchPreviewAssets'

interface ResolvedPreview {
  merged: Page
  /** The page whose scripts run — the routed page, or the entry template. */
  scriptPage: Page
  templateContext: TemplateRenderDataContext
}

/**
 * A draft row in the shape the entry-template renderer expects. Draft rows
 * have no published version: the version number is 0 and the publish
 * timestamps fall back to the row's own.
 */
async function draftRowAsPublished(db: DbClient, row: DataRow, table: DataTable): Promise<PublishedDataRow> {
  const featuredMediaId = readFeaturedMediaCell(row.cells)
  let featuredMediaPath: string | null = null
  if (featuredMediaId) {
    const { rows } = await db<{ public_path: string }>`
      select public_path from media_assets where id = ${featuredMediaId} limit 1
    `
    featuredMediaPath = rows[0]?.public_path ?? null
  }
  const publisher = row.publishedBy ?? row.updatedBy
  return {
    id: row.id,
    rowId: row.id,
    tableId: table.id,
    tableSlug: table.slug,
    tableKind: table.kind,
    tableRouteBase: table.routeBase,
    versionNumber: 0,
    cells: row.cells,
    slug: row.slug,
    featuredMediaId,
    featuredMediaPath,
    authorUserId: row.authorUserId,
    authorName: row.author?.displayName ?? null,
    authorRoleSlug: row.author?.roleSlug ?? null,
    authorRoleName: row.author?.roleName ?? null,
    publishedByUserId: publisher?.id ?? null,
    publishedByName: publisher?.displayName ?? null,
    publishedByRoleSlug: publisher?.roleSlug ?? null,
    publishedByRoleName: publisher?.roleName ?? null,
    publishedAt: row.publishedAt ?? row.updatedAt,
    createdAt: row.createdAt,
  }
}

async function resolvePreview(
  db: DbClient,
  scope: BranchScope,
  site: SiteDocument,
  url: URL,
): Promise<ResolvedPreview | null> {
  const slug = publicSlugFromPath(url.pathname)
  const page = site.pages.find((candidate) => candidate.slug === slug && !isTemplatePage(candidate))
  if (page) {
    const chain = resolveTemplateChain(site, { kind: 'page' })
    return {
      merged: composeTemplateChain(chain, { kind: 'page', page }),
      scriptPage: page,
      templateContext: { entryStack: [], route: buildRouteFrame(url.toString()) },
    }
  }

  const route = contentRouteFromPath(url.pathname)
  if (!route) return null
  const routeBase = normalizeRouteBase(route.tableRouteBase)
  const tables = await listDataTables(db, scope)
  const table = tables.find((candidate) => normalizeRouteBase(candidate.routeBase) === routeBase)
  if (!table) return null
  const row = await getDataRowBySlug(db, scope, table.id, route.rowSlug)
  if (!row) return null

  const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: table.slug })
  if (chain.length === 0) return null
  const merged = composeTemplateChain(chain, { kind: 'entry' })
  if (typeof row.cells.title === 'string') merged.title = row.cells.title
  const published = await draftRowAsPublished(db, row, table)
  return {
    merged,
    scriptPage: chain[chain.length - 1] ?? merged,
    templateContext: {
      entryStack: [publishedDataRowToLoopItem(published)],
      route: buildRouteFrame(url.toString()),
    },
  }
}

/**
 * Bundle the page's runtime scripts, reusing a build whose inputs are
 * unchanged. The build id hashes the site runtime config plus the page, so
 * editing a script on the branch mints a new build on the next view.
 */
async function buildPreviewRuntime(site: SiteDocument, page: Page) {
  const runtime = normalizeSiteRuntimeConfig(site.runtime)
  const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
    ? await ensureRuntimeDependencyCache(runtime.dependencyLock)
    : undefined
  const buildId = createHash('sha256')
    .update(canonicalJson({ runtime: site.runtime, page, lock: dependencyCache?.hash ?? null }))
    .digest('hex')
    .slice(0, 24)
  const assetBasePath = previewAssetBasePath(buildId)
  const build = await buildSiteRuntimeScripts({
    site,
    page,
    target: 'publish',
    assetBasePath,
    dependencyCache,
  })
  if (!hasPreviewBuild(buildId)) rememberPreviewBuild(buildId, build.files)

  let runtimePackageImportmap: PublishedRuntimePackageImportmap | undefined
  if (dependencyCache) {
    const built = await buildRuntimePackageImportmap(runtime.dependencyLock, dependencyCache)
    if (built) {
      const serialized = await serializeImportmapForCsp(built.importmap)
      runtimePackageImportmap = { body: serialized.body, sha256: serialized.sha256 }
    }
  }
  return { runtimeAssets: build.runtimeAssets, runtimePackageImportmap }
}

function previewBanner(branchName: string): string {
  return (
    `<div id="instatic-branch-preview" role="status" ` +
    `style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;` +
    `justify-content:center;gap:12px;padding:10px 16px;background:#111;color:#fff;` +
    `font:600 13px/1.4 system-ui,sans-serif">` +
    `<span>Previewing branch <strong>${escapeHtml(branchName)}</strong> — not live</span>` +
    `<a href="${BRANCH_PREVIEW_EXIT_PATH}" style="color:#9ecbff">Exit preview</a>` +
    `</div>`
  )
}

/**
 * Render `url` from the branch's draft, or null when the branch has nothing
 * at that path (the dispatcher then serves the 404 page).
 */
export async function renderBranchPreview(
  db: DbClient,
  branchId: string,
  url: URL,
): Promise<Response | null> {
  const scope: BranchScope = { branchId }
  const [branch, site] = await Promise.all([getBranch(db, branchId), getDraftSiteDocument(db, scope)])
  if (!branch || !site) return null
  const resolved = await resolvePreview(db, scope, site, url)
  if (!resolved) return null

  const { merged, scriptPage, templateContext } = resolved
  const { runtimeAssets, runtimePackageImportmap } = await buildPreviewRuntime(site, scriptPage)
  // A preview is one uncached render with the request in hand, so
  // request-dependent nodes resolve inline instead of becoming holes that
  // the hole endpoint would hydrate from main's published data.
  const segments = url.pathname.split('/').filter(Boolean)
  const request: SourceRequestContext = {
    query: Object.fromEntries(url.searchParams),
    path: url.pathname,
    slug: segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]!) : null,
    cookies: {},
  }
  const loopData = await prefetchLoopData(merged, site, db, url, { branchId, request })
  const mediaAssets = await prefetchMediaAssets(merged, site, registry, db, { templateContext, loopData })
  const rendered = publishPage(merged, site, registry, {
    templateContext,
    runtimeAssets,
    runtimePackageImportmap,
    loopData,
    mediaAssets,
    dynamicNodes: 'inline',
    publishVersion: getPublishVersion(),
  })
  const withFrontend = injectFrontendAssets(rendered.html, await collectFrontendInjections(db))
  const banner = previewBanner(branch.name)
  const html = withFrontend.includes('</body>')
    ? withFrontend.replace('</body>', `${banner}</body>`)
    : `${withFrontend}${banner}`

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  })
}
