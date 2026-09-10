/**
 * Draft-aware preview rendering for the Content workspace's Live mode.
 *
 * The published renderer in `server/publish/publicRenderer.ts` works
 * against a `PublishedDataRow` snapshot — it shows the *published* state
 * of an entry. The Content editor's Live mode needs to show the *draft*
 * state instead, so authors can see how their in-progress edits look
 * inside the real template + site CSS without publishing first.
 *
 * This handler mirrors `renderPublishedDataRowTemplate` but builds a
 * synthetic `LoopItem` from the request's draft cells (or the active
 * version's cells when no overrides are passed). The HTML is post-
 * processed by the same `applyPublishedHtmlPipeline` as a public-route
 * response so plugin asset injection + filter hooks behave identically.
 *
 * Security: requires data-read access on the row's table. The endpoint
 * does NOT mutate the database — it's a render-only pipeline.
 */

import { Type } from '@sinclair/typebox'
import type { DbClient } from '../../../db/client'
import type { DataRow, DataRowCells, PublishedDataRow } from '@core/data/schemas'
import { readEntrySeoOverride } from '@core/data/cells'
import { resolveTemplateChain, composeTemplateChain } from '@core/templates'
import { buildRouteFrame } from '@core/templates/contextFrames'
import { publishPage } from '@core/publisher'
import { buildSiteCssBundle } from '../../../publish/siteCssBundle'
import { buildPublishedSiteModuleJsMap } from '../../../publish/moduleJsBundle'
import { getPublishVersion } from '../../../publish/publishState'
import { prefetchLoopData, publishedDataRowToLoopItem } from '../../../publish/loopPrefetch'
import { prefetchMediaAssets } from '../../../publish/mediaPrefetch'
import { registry } from '@core/module-engine'
import { getDraftSiteDocument, getLatestPublishedSiteSnapshot } from '../../../repositories/publish'
import { getDefaultLocale, getTableLocalization } from '../../../repositories/localization'
import { buildLocalizedPath } from '@core/localization-routing'
import { requestLocale } from '../localeContext'
import { getDataRow, getDataTable } from '../../../repositories/data'
import { applyPublishedHtmlPipeline } from '../../../publish/publishedHtmlPipeline'
import { badRequest, jsonResponse, readValidatedBody } from '../../../http'
import { canReadDataRow, canReadTable, forbidden, requireDataAccess } from './access'
import type { RouteParams } from '../routeTable'

const CSS_ASSET_BASE_URL = '/_instatic/css/'
const LOOP_ENDPOINT_BASE_URL = '/_instatic/loop/'

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const PreviewBodySchema = Type.Object({
  /**
   * Override the entry's persisted cells with the draft state the
   * editor holds in memory. When omitted (or partial), the persisted
   * cells fill the gaps so the renderer always sees a complete row.
   */
  cells: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRowPreview(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireDataAccess(req, db)
  if (user instanceof Response) return user

  const locale = await requestLocale(req, db)
  if (locale instanceof Response) return locale
  const row = await getDataRow(db, params.id, locale.id)
  if (!row) return jsonResponse({ error: 'Row not found' }, { status: 404 })

  const table = await getDataTable(db, row.tableId)
  if (!table) return jsonResponse({ error: 'Table not found' }, { status: 404 })
  // System-table rows need data.system.tables.read even to preview (GHSA-x69h).
  if (!canReadTable(user, table)) return jsonResponse({ error: 'Row not found' }, { status: 404 })

  if (!canReadDataRow(user, row)) return forbidden()
  if (table.kind !== 'postType') return badRequest('Only post-type rows can be previewed')

  const body = await readValidatedBody(req, PreviewBodySchema)
  if (!body) return badRequest('Body must be { cells?: Record<string, unknown> }')

  const draftCells: DataRowCells = {
    ...row.cells,
    ...(body.cells ?? {}),
  }

  const [site, snapshot] = await Promise.all([
    getDraftSiteDocument(db, { localeId: locale.id }),
    getLatestPublishedSiteSnapshot(db, locale.id),
  ])
  if (!site) return jsonResponse({ error: 'Site draft not found' }, { status: 404 })
  const primary = await getDefaultLocale(db)
  const routeConfig = await getTableLocalization(db, table.id, locale.id)
    ?? await getTableLocalization(db, table.id, primary.id)
  const routeBase = routeConfig?.routeBase ?? table.routeBase

  // Resolve the full chain (everywhere layout + entry template) and merge it
  // into one tree, exactly like the live renderer, so the preview matches what
  // gets published.
  const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: table.slug })
  if (chain.length === 0) {
    return jsonResponse({ error: 'No entry template found for this collection' }, { status: 404 })
  }
  const merged = composeTemplateChain(chain, { kind: 'entry' })
  // The template chain has no Page for the entry, so composeTemplateChain
  // can't know its title — the entry's own (draft) title is the real page
  // title. The draft SEO override travels separately through
  // `documentMeta` so it only ever reaches the `<head>`, mirroring publish.
  if (typeof draftCells.title === 'string') merged.title = draftCells.title

  // Build a synthetic PublishedDataRow with the draft cells merged in.
  // Bindings inside the template (`{currentEntry.body}`, featured-media
  // resolution, etc.) operate against this seed.
  const draftPublishedRow: PublishedDataRow = synthesisePublishedRow(row, { ...table, routeBase }, draftCells, buildLocalizedPath(locale, typeof draftCells.slug === 'string' ? draftCells.slug : row.slug, routeBase))

  const publicPath = draftPublishedRow.publicPath
  const syntheticUrl = new URL(`http://localhost${publicPath}`)
  const templateContext = {
    entryStack: [publishedDataRowToLoopItem(draftPublishedRow)],
    route: buildRouteFrame(syntheticUrl.toString()),
  }
  const loopData = await prefetchLoopData(merged, site, db)
  const mediaAssets = await prefetchMediaAssets(merged, site, registry, db, {
    templateContext,
    loopData,
  })
  const cssBundle = buildSiteCssBundle(site, registry, merged, { mediaAssets })

  const published = publishPage(merged, site, registry, {
    templateContext,
    documentMeta: readEntrySeoOverride(draftCells),
    runtimeAssets: snapshot?.runtimeAssets,
    runtimePackageImportmap: snapshot?.runtimePackageImportmap,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    mediaAssets,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
  })
  const moduleJsMap = buildPublishedSiteModuleJsMap(site, registry)

  const finalHtml = await applyPublishedHtmlPipeline(
    {
      html: published.html,
      pageId: merged.id,
      slug: merged.slug,
      siteId: site.id,
      cssBundle,
      jsModuleIds: published.jsModuleIds.filter((id) => moduleJsMap.has(id)),
      publishVersion: getPublishVersion(),
    },
    db,
  )

  return new Response(finalHtml, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function synthesisePublishedRow(
  row: DataRow,
  table: { id: string; slug: string; routeBase: string; kind: string },
  cells: DataRowCells,
  publicPath: string,
): PublishedDataRow {
  const now = new Date().toISOString()
  const slug = typeof cells['slug'] === 'string' ? cells['slug'] : row.slug
  return {
    id: row.id,
    rowId: row.id,
    localeId: row.localeId,
    publicPath,
    siteSnapshotId: null,
    tableId: row.tableId,
    tableSlug: table.slug,
    tableKind: 'postType',
    tableRouteBase: table.routeBase,
    versionNumber: 0,
    cells,
    slug,
    featuredMediaId: typeof cells['featuredMedia'] === 'string' ? cells['featuredMedia'] : null,
    // The publisher resolves the featured media path from the asset
    // registry at render time; for a draft preview we pass the asset
    // id straight through. If the editor draft references an asset
    // that has been deleted, the renderer simply emits no image — same
    // behaviour as the published path.
    featuredMediaPath: null,
    authorUserId: row.authorUserId,
    authorName: null,
    authorRoleSlug: null,
    authorRoleName: null,
    publishedByUserId: null,
    publishedByName: null,
    publishedByRoleSlug: null,
    publishedByRoleName: null,
    publishedAt: row.publishedAt ?? now,
    createdAt: row.createdAt,
  }
}
