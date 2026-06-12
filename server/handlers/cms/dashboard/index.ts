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
 * No filtering / range tabs yet — the dashboard's "Today / 7d / 30d"
 * range affects only the analytics widgets (which live in the plugin's
 * own `/runtime/stats` route). The Pages / Posts / Media counters in
 * this response are point-in-time totals + a fixed "this week" delta.
 *
 * File layout for this folder:
 *   index.ts         — this file: route handler + endpoint registry
 *   types.ts         — every response shape on the wire
 *   shared.ts        — SQL + coercion helpers used by 2+ readers
 *   <widget>.ts      — one file per widget reader (pages, posts, media,
 *                      plugins, publishLineup, activity, storage)
 *
 * One-reader helpers stay co-located in their reader's file so the call
 * site is obvious. Adding a new widget is: new `<widget>.ts` reader +
 * one entry in `DASHBOARD_READERS` below.
 */
import type { DbClient } from '../../../db/client'
import { requireAuthenticatedUser, requireCapability } from '../../../auth/authz'
import type { CoreCapability } from '../../../auth/capabilities'
import { jsonResponse, methodNotAllowed } from '../../../http'
import { CMS_API_PREFIX, type CmsHandlerOptions } from '../shared'
import { resolveTimeZone } from '../../../time'
import { readPagesStats } from './pages'
import { readPostsStats } from './posts'
import { readMediaStats } from './media'
import { readPluginsStats } from './plugins'
import { readPublishLineup } from './publishLineup'
import { readRecentActivity } from './activity'
import { readStorageStats } from './storage'
import type { DashboardRequestContext } from './types'

// Re-export the on-the-wire types so callers that need to type the
// JSON response (currently `src/admin/pages/dashboard/hooks/
// useDashboardStats.ts` mirrors them by hand) can import from the
// folder barrel rather than reaching into the types file directly.


type DashboardReader = (
  db: DbClient,
  options: CmsHandlerOptions,
  ctx: DashboardRequestContext,
) => Promise<unknown>

interface DashboardEndpoint {
  reader: DashboardReader
  /**
   * Required capability for this widget. `null` = any authenticated user
   * can read (the underlying counts are non-sensitive — pure totals, no
   * row content, no actor identity).
   *
   * Widget UIs in the admin treat a 403 as "hide this widget", so a
   * Client whose role lacks a specific capability simply doesn't see
   * those tiles on their dashboard.
   */
  capability: CoreCapability | null
}

// `/dashboard/<segment>` → endpoint. The segment is the public slug,
// each entry carries a reader function plus the capability gate. Adding
// a new widget is "new reader file + one row here". The capability
// rules:
//
//   pages / posts / publish-lineup / storage
//                       Non-sensitive totals or paths the visitor could
//                       hit on the public site anyway. Any authenticated
//                       user can read.
//
//   media               Library thumbnails are part of the asset surface;
//                       gate matches `/media` list (`media.read`).
//
//   plugins             Plugin names, versions, and lifecycle states are
//                       installation telemetry — `plugins.read` mirrors
//                       the gate the admin endpoint uses.
//
//   activity            **Audit-class data** — actor display name + email
//                       gravatar + action + target. Same gate as the
//                       dedicated audit endpoint (`audit.read`). Previous
//                       behaviour leaked this to every authenticated user
//                       via the dashboard — A2 fix.
const DASHBOARD_READERS: Record<string, DashboardEndpoint> = {
  'pages':          { reader: readPagesStats,     capability: null },
  'posts':          { reader: readPostsStats,     capability: null },
  'media':          { reader: readMediaStats,     capability: 'media.read' },
  'plugins':        { reader: readPluginsStats,   capability: 'plugins.read' },
  'storage':        { reader: readStorageStats,   capability: null },
  'publish-lineup': { reader: readPublishLineup,  capability: null },
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

  // Per-endpoint capability gate. `null` capability falls back to the
  // authenticated-user floor; everything else uses requireCapability so
  // the widget hides when the caller's role lacks the cap.
  const user = endpoint.capability === null
    ? await requireAuthenticatedUser(req, db)
    : await requireCapability(req, db, endpoint.capability)
  if (user instanceof Response) return user

  const ctx: DashboardRequestContext = {
    timeZone: resolveTimeZone(url.searchParams.get('tz')),
  }
  const body = await endpoint.reader(db, options, ctx)
  return jsonResponse(body)
}
