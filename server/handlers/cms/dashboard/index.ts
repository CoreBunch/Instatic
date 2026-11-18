/**
 * Dashboard stats endpoints — per-domain.
 *
 *   GET /admin/api/cms/dashboard/pages
 *   GET /admin/api/cms/dashboard/posts
 *   GET /admin/api/cms/dashboard/media
 *   GET /admin/api/cms/dashboard/plugins
 *   GET /admin/api/cms/dashboard/storage
 *   GET /admin/api/cms/dashboard/publish-lineup
 *   GET /admin/api/cms/dashboard/activity
 *
 * One endpoint per dashboard widget data domain. Each runs only the
 * queries that domain needs, so:
 *   1. The client fires all endpoints in parallel from the widget hooks.
 *      Cheap domains (Pages: two counts) resolve in ~10 ms; the
 *      expensive Activity feed (audit_events scan + 50-row projection)
 *      takes ~150 ms. The dashboard fills in progressively as data
 *      arrives, instead of stalling on the slowest widget.
 *   2. A widget that doesn't appear in the user's grid never causes
 *      its endpoint to be called. Adding a new widget that pulls
 *      data from a new source means a new endpoint, not bloating an
 *      existing aggregate.
 *
 * First-party dashboard readers have fixed scopes. The page header's
 * local range control is not threaded into these endpoints; Pages /
 * Posts / Media counters are point-in-time totals plus their reader's
 * fixed deltas or histograms.
 *
 * This folder owns dispatch, request context, and the media/plugin/activity/
 * storage readers. Authorized content queries and result types live in
 * server/repositories/dashboard/. Register each reader with an explicit gate.
 */
import type { DbClient } from '../../../db/client'
import { requireCapability, userHasCapability } from '../../../auth/authz'
import type { CoreCapability } from '../../../auth/capabilities'
import { jsonResponse, methodNotAllowed } from '../../../http'
import { CMS_API_PREFIX, type CmsHandlerOptions } from '../shared'
import { resolveTimeZone } from '../../../time'
import { readPagesStats, readPostsStats, readPublishLineup } from '../../../repositories/dashboard'
import { readMediaStats } from './media'
import { readPluginsStats } from './plugins'
import { readRecentActivity } from './activity'
import { readStorageStats } from './storage'
import type { DashboardRequestContext } from './types'

type DashboardReader = (
  db: DbClient,
  options: CmsHandlerOptions,
  ctx: DashboardRequestContext,
) => Promise<unknown>

interface DashboardEndpoint {
  reader: DashboardReader
  /** Additional domain gate; dashboard.read is required for every endpoint. */
  capability: CoreCapability
}

const DASHBOARD_READERS: Record<string, DashboardEndpoint> = {
  'pages':          { reader: (db, _options, ctx) => readPagesStats(db, ctx.principal),     capability: 'dashboard.read' },
  'posts':          { reader: (db, _options, ctx) => readPostsStats(db, ctx.principal, ctx.timeZone),     capability: 'dashboard.read' },
  'media':          { reader: readMediaStats,     capability: 'media.read' },
  'plugins':        { reader: readPluginsStats,   capability: 'plugins.read' },
  'storage':        { reader: readStorageStats,   capability: 'storage.elect' },
  'publish-lineup': { reader: (db, _options, ctx) => readPublishLineup(db, ctx.principal),  capability: 'dashboard.read' },
  'activity':       { reader: readRecentActivity, capability: 'audit.read' },
}

export async function handleDashboardRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  const prefix = `${CMS_API_PREFIX}/dashboard/`
  if (!url.pathname.startsWith(prefix)) return null
  const segment = url.pathname.slice(prefix.length)
  const endpoint = DASHBOARD_READERS[segment]
  if (!endpoint) return null
  if (req.method !== 'GET') return methodNotAllowed()

  const user = await requireCapability(req, db, 'dashboard.read')
  if (user instanceof Response) return user
  if (!userHasCapability(user, endpoint.capability)) {
    return jsonResponse({ error: 'Forbidden' }, { status: 403 })
  }

  const ctx: DashboardRequestContext = {
    principal: user,
    timeZone: resolveTimeZone(url.searchParams.get('tz')),
  }
  const body = await endpoint.reader(db, options, ctx)
  return jsonResponse(body)
}
