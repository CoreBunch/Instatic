/**
 * CMS handler entry point.
 *
 * `handleCmsRequest` is invoked by `server/router.ts` for every request
 * whose path starts with `/admin/api/cms/`. It does two things in order:
 *
 *  1. Defense-in-depth CSRF: state-changing methods (POST/PUT/PATCH/DELETE)
 *     must come from an Origin that matches the request's own origin (or
 *     a dev allowlist entry). `SameSite=Lax` already covers most CSRF;
 *     this catches the same-site-different-subdomain edge case before
 *     any handler runs.
 *
 *  2. Dispatch to the route-group handlers in `./<group>.ts`. Each group
 *     module owns its URL matching and returns either a `Response` (it
 *     handled the request) or `null` (not my route — try the next group).
 *     The first group to return a `Response` wins; if every group passes,
 *     we fall through to a 404.
 *
 * Routes are not nested into a tree because the prefix is short
 * (`/admin/api/cms/`) and each group's match logic is small enough that
 * a simple ordered chain is faster *and* easier to read than a router
 * abstraction with config objects. New route groups just need a new
 * file in this directory and one entry in `routeGroups` below.
 *
 * Loop traffic (`/_instatic/loop/...`) lives next door in `./loop.ts` and is
 * dispatched directly by the top-level router, not through this entry
 * point — its prefix is outside `/admin/api/cms/`.
 */
import type { DbClient } from '../../db/client'
import { jsonResponse } from '../../http'
import { isStateChangingMethod, originAllowed } from '../../auth/security'
import type { CmsHandlerOptions } from './shared'
import { handleSetupRoutes } from './setup'
import { handleAuthRoutes } from './auth'
import { handleMeRoutes } from './me'
import { handleUserPreferencesRoutes } from './userPreferences'
import { handleUsersRoutes } from './users'
import { handleRolesRoutes } from './roles'
import { handleAuditRoutes } from './audit'
import { handleSiteRoutes } from './site'
import { handlePagesRoutes } from './pages'
import { handleComponentsRoutes } from './components'
import { handleLayoutsRoutes } from './layouts'
import { handleRuntimeRoutes } from './runtime'
import { handleMediaRoutes } from './media'
import { handleMediaFolderRoutes } from './mediaFolders'
import { handleMediaStorageAdminRoutes } from './mediaStorageAdmin'
import { handlePluginsRoutes } from './plugins'
import { handleDataRoutes } from './data'
import { handleSeoRoutes } from './seo'
import { handleDashboardRoutes } from './dashboard'
import { handleFontsRoutes } from './fonts'
import { handlePublishRoutes } from './publish'
import { handleExportRoute } from './export'
import { handleImportPreviewRoute } from './importPreview'
import { handleImportArchiveRoute } from './importArchive'
import { handleImportRoute } from './import'

export type { CmsHandlerOptions } from './shared'

export async function handleCmsRequest(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response> {
  // CSRF defense in depth: reject state-changing requests whose Origin
  // header doesn't match the request's own origin (or a dev allowlist
  // entry). SameSite=Lax already covers most CSRF; this closes the
  // same-site-different-subdomain edge case and gives a clear 403 instead
  // of executing a forged action. Safe methods (GET/HEAD/OPTIONS) are not
  // checked — they shouldn't mutate state by definition.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  // Try each route group in order. The first to return a non-null
  // Response handled the request; null means "this group didn't match,
  // try the next one".
  const response =
    (await handleSetupRoutes(req, db))
    ?? (await handleMeRoutes(req, db, options))
    ?? (await handleAuthRoutes(req, db))
    // User preferences sit next to /me/* because they share the same
    // self-targeted "anything an authenticated user can do to their own
    // account" surface. Routes mount under `/admin/api/cms/me/preferences/`.
    ?? (await handleUserPreferencesRoutes(req, db))
    ?? (await handleUsersRoutes(req, db))
    ?? (await handleRolesRoutes(req, db))
    ?? (await handleAuditRoutes(req, db))
    ?? (await handleSiteRoutes(req, db))
    ?? (await handlePagesRoutes(req, db))
    ?? (await handleComponentsRoutes(req, db))
    ?? (await handleLayoutsRoutes(req, db))
    ?? (await handleRuntimeRoutes(req, db))
    // The folder routes match `/admin/api/cms/media/folders/...` so they must
    // run BEFORE the asset routes whose `/admin/api/cms/media/:id` pattern
    // would otherwise eat them (treating "folders" as an asset id). The
    // storage-admin routes (`/admin/api/cms/media/storage/...`) follow
    // the same rule — `/media/:id` would otherwise consume "storage".
    ?? (await handleMediaFolderRoutes(req, db))
    ?? (await handleMediaStorageAdminRoutes(req, db, options))
    ?? (await handleMediaRoutes(req, db))
    ?? (await handlePluginsRoutes(req, db, options))
    ?? (await handleDataRoutes(req, db, options))
    ?? (await handleSeoRoutes(req, db, options))
    // Dashboard stats — read-only aggregate counts used by the admin
    // dashboard widgets. Lives after data routes so future routes
    // under `/data/...` can never accidentally shadow it.
    ?? (await handleDashboardRoutes(req, db, options))
    ?? (await handleFontsRoutes(req, db, options))
    ?? (await handlePublishRoutes(req, db, options))
    // Export and import are registered after data routes so their exact paths
    // `/export` and `/import` cannot conflict with any `/data/...` sub-routes.
    // Preview must come before import: `/import/preview` is a longer path that
    // would otherwise be consumed by the `/import` handler first.
    ?? (await handleExportRoute(req, db, options))
    ?? (await handleImportPreviewRoute(req, db))
    ?? (await handleImportArchiveRoute(req, db, options))
    ?? (await handleImportRoute(req, db, options))

  return response ?? jsonResponse({ error: 'Not found' }, { status: 404 })
}
