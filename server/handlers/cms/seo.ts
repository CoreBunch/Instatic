/**
 * SEO workspace API — `/admin/api/cms/seo/*`.
 *
 *   GET  /seo/targets        — the complete target index (pages, templates,
 *                              post rows) plus site SEO defaults and the
 *                              configured public origin. Draft cells: the
 *                              workspace edits drafts, publish takes them live.
 *   PUT  /seo/targets/:kind/:id — write one target's structured `seo` cell.
 *   PUT  /seo/site           — write `site.settings.seo` (defaults + robots
 *                              + sitemap settings live in one object; the
 *                              Robots/Sitemap tabs save through here too).
 *
 * Capabilities: `seo.read` to read, `seo.manage` to write. Target writes
 * additionally require the persona that owns the underlying target —
 * `pages.edit` for page/template rows, a content-edit capability for post
 * rows — so the SEO workspace can't smuggle edits past the content gates.
 */
import { Type } from '@core/utils/typeboxHelpers'
import type { DataRow, DataTable } from '@core/data/schemas'
import { readSeoCell, readTitleCell } from '@core/data/cells'
import { SeoMetadataSchema, SiteSeoSettingsSchema, parseSiteSeoSettings } from '@core/seo'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import { parsePageTemplate } from '@core/page-tree'
import type { DbClient } from '../../db/client'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireCapability, userHasAnyCapability, userHasCapability } from '../../auth/authz'
import { canonicalPublicOrigin } from '../../auth/security'
import { getDraftSite, saveDraftSite } from '../../repositories/site'
import { listDataTables } from '../../repositories/data/tables'
import { getDataRow, listDataRows, saveDataRowDraft } from '../../repositories/data'
import { CMS_API_PREFIX } from './shared'
import type { CmsHandlerOptions } from './shared'
import { runRouteTable, type Route, type RouteParams } from './routeTable'
import { handleSeoGenerate } from './seoGenerate'

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

const SeoTargetPutBodySchema = Type.Object({
  seo: SeoMetadataSchema,
})

const SiteSeoPutBodySchema = Type.Object({
  seo: SiteSeoSettingsSchema,
})

// ---------------------------------------------------------------------------
// Target index
// ---------------------------------------------------------------------------

export type SeoTargetKind = 'page' | 'template' | 'post'

interface SeoTargetPayload {
  kind: SeoTargetKind
  id: string
  title: string
  /** Public route path; null for templates (not directly routable). */
  route: string | null
  tableSlug?: string
  tableLabel?: string
  /**
   * Templates only: the postType table slugs this entry template applies
   * to. Lets the admin preview resolve a post's template title pattern
   * exactly like the publisher does. (`everywhere` layout templates are
   * not SEO targets at all — the pages they wrap own the metadata.)
   */
  templateTableSlugs?: string[]
  seo: ReturnType<typeof readSeoCell> | null
  status: string
  updatedAt: string
  publishedAt: string | null
}

/**
 * Map a pages-table row to a target — or null for `everywhere` layout
 * templates: they have no route and no content of their own, so per-target
 * metadata is meaningless (the wrapped pages own their SEO). Only entry
 * templates (postTypes targets) are SEO targets, as token-pattern sources
 * for their posts.
 */
function pageRowToTarget(row: DataRow): SeoTargetPayload | null {
  const template = row.cells.templateEnabled === true
    ? parsePageTemplate({
        enabled: true,
        target: row.cells.templateTarget,
        priority: row.cells.templatePriority,
      })
    : null
  // Mirrors isTemplatePage(page): parsePageTemplate only returns a config
  // for enabled templates, so a non-null config means "template page".
  const isTemplate = template !== null
  const entryTarget = template !== null && template.target.kind === 'postTypes' ? template.target : null
  if (isTemplate && entryTarget === null) return null
  const slug = row.slug.replace(/^\/+/, '')
  return {
    kind: isTemplate ? 'template' : 'page',
    id: row.id,
    title: readTitleCell(row.cells) || row.slug,
    route: isTemplate ? null : slug === 'index' || slug === '' ? '/' : `/${slug}`,
    ...(entryTarget !== null ? { templateTableSlugs: entryTarget.tableSlugs } : {}),
    seo: readSeoCell(row.cells) ?? null,
    status: row.status,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  }
}

function postRowToTarget(row: DataRow, table: DataTable): SeoTargetPayload {
  const routeBase = normalizeRouteBase(table.routeBase ?? '')
  return {
    kind: 'post',
    id: row.id,
    title: readTitleCell(row.cells) || row.slug,
    route: routeBase ? `${routeBase}/${row.slug}` : null,
    tableSlug: table.slug,
    tableLabel: table.pluralLabel,
    seo: readSeoCell(row.cells) ?? null,
    status: row.status,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  }
}

async function handleGetTargets(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'seo.read')
  if (user instanceof Response) return user

  const [site, tables, pageRows] = await Promise.all([
    getDraftSite(db),
    listDataTables(db),
    listDataRows(db, 'pages'),
  ])

  const postTables = tables.filter((table) => table.kind === 'postType')
  const postTargets: SeoTargetPayload[] = []
  for (const table of postTables) {
    const rows = await listDataRows(db, table.id)
    for (const row of rows) postTargets.push(postRowToTarget(row, table))
  }

  return jsonResponse({
    siteName: site?.name ?? '',
    language: site?.settings.language ?? null,
    publicOrigin: canonicalPublicOrigin(),
    faviconUrl: site?.settings.faviconUrl ?? null,
    siteSeo: site?.settings.seo ?? null,
    targets: [
      ...pageRows.map(pageRowToTarget).filter((target) => target !== null),
      ...postTargets,
    ],
  })
}

// ---------------------------------------------------------------------------
// Target write
// ---------------------------------------------------------------------------

async function handlePutTarget(
  req: Request,
  db: DbClient,
  params: RouteParams,
): Promise<Response> {
  const user = await requireCapability(req, db, 'seo.manage')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, SeoTargetPutBodySchema)
  if (!body) return badRequest('Invalid SEO metadata payload')

  const row = await getDataRow(db, params.id)
  if (!row) return jsonResponse({ error: 'Target not found' }, { status: 404 })

  const isPageRow = row.tableId === 'pages'
  const kindMatchesRow = isPageRow
    ? params.kind === 'page' || params.kind === 'template'
    : params.kind === 'post'
  if (!kindMatchesRow) return badRequest('Target kind does not match the row')

  // Target-level ownership: the SEO workspace must not smuggle writes past
  // the personas that own the underlying rows.
  if (isPageRow) {
    if (!userHasCapability(user, 'pages.edit')) {
      return jsonResponse({ error: 'Forbidden' }, { status: 403 })
    }
  } else if (!userHasAnyCapability(user, ['content.edit.any', 'content.manage'])) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const updated = await saveDataRowDraft(
    db,
    row.id,
    { cells: { ...row.cells, seo: body.seo }, slug: row.slug },
    user.id,
  )
  if (!updated) return jsonResponse({ error: 'Target not found' }, { status: 404 })

  return jsonResponse({
    target: row.tableId === 'pages'
      ? pageRowToTarget(updated)
      : postRowToTarget(updated, (await listDataTables(db)).find((t) => t.id === row.tableId)!),
  })
}

// ---------------------------------------------------------------------------
// Site SEO settings (defaults + robots + sitemap)
// ---------------------------------------------------------------------------

async function handlePutSiteSeo(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'seo.manage')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, SiteSeoPutBodySchema)
  if (!body) return badRequest('Invalid site SEO payload')

  const site = await getDraftSite(db)
  if (!site) return jsonResponse({ error: 'Site not found' }, { status: 404 })

  const seo = parseSiteSeoSettings(body.seo)
  await saveDraftSite(db, { ...site, settings: { ...site.settings, seo } }, user.id)

  return jsonResponse({ seo: seo ?? null })
}

// ---------------------------------------------------------------------------
// Route table + dispatcher
// ---------------------------------------------------------------------------

const SEO_ROUTES: readonly Route<[CmsHandlerOptions]>[] = [
  { method: 'GET', pattern: `${CMS_API_PREFIX}/seo/targets`, handler: handleGetTargets },
  {
    method: 'PUT',
    pattern: new RegExp(`^${CMS_API_PREFIX}/seo/targets/(?<kind>page|template|post)/(?<id>[^/]+)$`),
    handler: handlePutTarget,
  },
  { method: 'PUT', pattern: `${CMS_API_PREFIX}/seo/site`, handler: handlePutSiteSeo },
  { method: 'POST', pattern: `${CMS_API_PREFIX}/seo/generate`, handler: handleSeoGenerate },
]

export async function handleSeoRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  return runRouteTable(req, db, SEO_ROUTES, options)
}
