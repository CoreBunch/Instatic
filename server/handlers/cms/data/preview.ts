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
import { resolveTemplateChain, composeTemplateChain } from '@core/templates'
import { buildRouteFrame } from '@core/templates/contextFrames'
import { publishPage } from '@core/publisher'
import { buildSiteCssBundle } from '../../../publish/siteCssBundle'
import { buildPublishedSiteModuleJsMap } from '../../../publish/moduleJsBundle'
import { getPublishVersion } from '../../../publish/publishState'
import { prefetchLoopData, publishedDataRowToLoopItem } from '../../../publish/loopPrefetch'
import { prefetchMediaAssets } from '../../../publish/mediaPrefetch'
import { registry } from '@core/module-engine'
import { getLatestPublishedSiteSnapshot } from '../../../repositories/publish'
import { getDataRow, getDataTable } from '../../../repositories/data'
import { applyPublishedHtmlPipeline } from '../../../publish/publishedHtmlPipeline'
import { badRequest, jsonResponse, readValidatedBody } from '../../../http'
import { canReadDataRow, forbidden, requireDataAccess } from './access'
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

  const row = await getDataRow(db, params.id)
  if (!row) return jsonResponse({ error: 'Row not found' }, { status: 404 })

  const table = await getDataTable(db, row.tableId)
  if (!table) return jsonResponse({ error: 'Table not found' }, { status: 404 })

  if (!canReadDataRow(user, row)) return forbidden()
  if (table.kind !== 'postType') return badRequest('Only post-type rows can be previewed')

  const body = await readValidatedBody(req, PreviewBodySchema)
  if (!body) return badRequest('Body must be { cells?: Record<string, unknown> }')

  const draftCells: DataRowCells = {
    ...row.cells,
    ...(body.cells ?? {}),
  }

  const snapshot = await getLatestPublishedSiteSnapshot(db)
  if (!snapshot) {
    return jsonResponse({ error: 'Site has no published version yet' }, { status: 409 })
  }

  // Resolve the full chain (everywhere layout + entry template) and merge it
  // into one tree, exactly like the live renderer, so the preview matches what
  // gets published.
  const chain = resolveTemplateChain(snapshot.site, { kind: 'entry', tableSlug: table.slug })
  if (chain.length === 0) {
    return jsonResponse({ error: 'No entry template found for this collection' }, { status: 404 })
  }
  const merged = composeTemplateChain(chain, { kind: 'entry' })

  // Build a synthetic PublishedDataRow with the draft cells merged in.
  // Bindings inside the template (`{currentEntry.body}`, featured-media
  // resolution, etc.) operate against this seed.
  const draftPublishedRow: PublishedDataRow = synthesisePublishedRow(row, table, draftCells)

  const cssBundle = buildSiteCssBundle(snapshot.site, registry, merged)
  const [loopData, mediaAssets] = await Promise.all([
    prefetchLoopData(merged, snapshot.site, db),
    prefetchMediaAssets(merged, snapshot.site, registry, db),
  ])

  const publicPath = buildEntryPublicPath(table.routeBase, draftPublishedRow.slug)
  const syntheticUrl = new URL(`http://localhost${publicPath}`)

  const published = publishPage(merged, snapshot.site, registry, {
    templateContext: {
      entryStack: [publishedDataRowToLoopItem(draftPublishedRow)],
      route: buildRouteFrame(syntheticUrl.toString()),
    },
    runtimeAssets: snapshot.runtimeAssets,
    runtimePackageImportmap: snapshot.runtimePackageImportmap,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    mediaAssets,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
  })
  const moduleJsMap = buildPublishedSiteModuleJsMap(snapshot.site, registry)

  const finalHtml = await applyPublishedHtmlPipeline(
    {
      html: published.html,
      pageId: merged.id,
      slug: merged.slug,
      siteId: snapshot.site.id,
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
): PublishedDataRow {
  const now = new Date().toISOString()
  const slug = typeof cells['slug'] === 'string' ? cells['slug'] : row.slug
  return {
    id: row.id,
    rowId: row.id,
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

function buildEntryPublicPath(routeBase: string, slug: string): string {
  const trimmed = routeBase.trim()
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  const normalised = withLeading.replace(/\/+$/g, '') || '/'
  return `${normalised === '/' ? '' : normalised}/${slug}`
}
