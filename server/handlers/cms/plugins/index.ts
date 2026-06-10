/**
 * Plugin admin endpoints — capabilities split per-route. The dispatcher
 * resolves each request to a (`plugins.read` / `plugins.configure` /
 * `plugins.install` / `plugins.lifecycle`) gate plus optional step-up.
 * See `resolvePluginRoutePolicy` below for the matrix.
 *
 *   GET    /admin/api/cms/plugins                                   — list installed plugins + admin pages
 *   POST   /admin/api/cms/plugins                                   — install from a manifest JSON body
 *   POST   /admin/api/cms/plugins/inspect-package                   — read a plugin .zip without installing
 *   POST   /admin/api/cms/plugins/package                           — install (or upgrade) from a .zip
 *   PATCH  /admin/api/cms/plugins/:id                               — enable / disable an installed plugin
 *   DELETE /admin/api/cms/plugins/:id                               — uninstall + delete on-disk assets
 *   POST   /admin/api/cms/plugins/:id/pack/install                  — manual pack re-sync into the draft site
 *   GET    /admin/api/cms/plugins/:id/settings                      — masked settings
 *   PUT    /admin/api/cms/plugins/:id/settings                      — update settings, push into the running VM, fire `settings.changed`
 *   POST   /admin/api/cms/plugins/:id/restart                       — manual restart for a parked plugin
 *   GET    /admin/api/cms/plugins/events                            — SSE stream of lifecycle events
 *   GET    /admin/api/cms/plugins/:id/resources/:rid/records        — list records for a plugin resource
 *   POST   /admin/api/cms/plugins/:id/resources/:rid/records        — create a plugin record
 *   PATCH  /admin/api/cms/plugins/:id/resources/:rid/records/:rec   — update a plugin record
 *   DELETE /admin/api/cms/plugins/:id/resources/:rid/records/:rec   — delete a plugin record
 *   *      /admin/api/cms/plugins/:id/runtime/...                   — opaque runtime requests handled by
 *                                                                     the plugin's own server module
 *
 * `handlePluginsRoutes` is a thin dispatcher: it resolves the per-route
 * capability + step-up policy via `resolvePluginRoutePolicy`, runs the gate,
 * then dispatches the request through the shared `runRouteTable` over
 * `PLUGIN_ROUTES`, forwarding the gated `user` (and `options`) as extra
 * context to one of the per-route handlers in the topic files (`install.ts`,
 * `state.ts`, `settings.ts`, `pack.ts`, `records.ts`, `events.ts`). The
 * opaque `runtime` pass-through is matched first, before the admin gate. The
 * lifecycle hook orchestration lives in `lifecycle.ts`; cross-cutting helpers
 * (`pluginsPayload`, audit envelope, permission grants, on-disk assets)
 * live in `shared.ts`.
 */
import type { DbClient } from '../../../db/client'
import type { CoreCapability } from '../../../auth/capabilities'
import type { AuthUser } from '../../../repositories/users'
import { requireCapability, requireStepUp } from '../../../auth/authz'
import {
  handleServerPluginRuntimeRequest,
  setPluginWorkerDbClient,
} from '../../../plugins/runtime'
import { jsonResponse } from '../../../http'
import { type CmsHandlerOptions } from '../shared'
import { runRouteTable, type Route } from '../routeTable'
import {
  handleInspectPackage,
  handlePackageInstall,
  handlePluginsCollection,
} from './install'
import { handlePluginPackInstall } from './pack'
import { handlePluginItem, handlePluginRestart } from './state'
import { handlePluginSettings } from './settings'
import {
  handlePluginRecordItem,
  handlePluginRecordsCollection,
} from './records'
import { handlePluginEventsStream } from './events'
import {
  handlePluginSchedulePause,
  handlePluginScheduleResume,
  handlePluginScheduleRunNow,
  handlePluginSchedulesList,
} from './schedules'

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

// `resolvePluginRoutePolicy` matches these with `.test()` (named groups are
// inert there); the route table reads the named groups (`id`, `rid`, `rec`,
// `sid`) to feed each handler's positional args.
const PLUGIN_ITEM_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)$/
const PLUGIN_RECORDS_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/resources\/(?<rid>[^/]+)\/records$/
const PLUGIN_RECORD_ITEM_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/resources\/(?<rid>[^/]+)\/records\/(?<rec>[^/]+)$/
const PLUGIN_RUNTIME_PATTERN = /^\/admin\/api\/cms\/plugins\/([^/]+)\/runtime(?:\/.*)?$/
const PLUGIN_PACK_INSTALL_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/pack\/install$/
const PLUGIN_SETTINGS_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/settings$/
const PLUGIN_RESTART_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/restart$/
const PLUGIN_SCHEDULES_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/schedules$/
const PLUGIN_SCHEDULE_RUN_NOW_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/schedules\/(?<sid>[^/]+)\/run-now$/
const PLUGIN_SCHEDULE_PAUSE_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/schedules\/(?<sid>[^/]+)\/pause$/
const PLUGIN_SCHEDULE_RESUME_PATTERN = /^\/admin\/api\/cms\/plugins\/(?<id>[^/]+)\/schedules\/(?<sid>[^/]+)\/resume$/
const PLUGIN_EVENTS_PATH = '/admin/api/cms/plugins/events'

// The bare `/plugins/:id` route must NOT claim the reserved single-segment
// children of `/plugins` (`events`, `package`, `inspect-package`) — those are
// exact routes owned by other handlers. The capability resolver above keeps
// using the unrestricted PLUGIN_ITEM_PATTERN, so a PATCH/DELETE to a reserved
// path still resolves its original gate before 405ing — exactly as the old
// exact-match-first dispatcher did.
const PLUGIN_ITEM_DISPATCH_PATTERN =
  /^\/admin\/api\/cms\/plugins\/(?<id>(?!(?:events|package|inspect-package)$)[^/]+)$/

// ---------------------------------------------------------------------------
// Per-route capability + step-up policy
//
// The legacy single-capability gate (`plugins.manage`) collapsed four very
// different blast radii — view, configure, install (RCE-class), lifecycle —
// into one grant. We split per-route so a "Site Operator" custom role can
// hold `plugins.lifecycle` without also being able to install new plugins.
//
// `resolvePluginRoutePolicy` returns the required capability + step-up
// expectation for the matched route. The capability is required ALWAYS;
// step-up is required only for `stepUp: true` entries (a fresh password
// re-entry on top, mirroring users.ts delete / password.change).
// ---------------------------------------------------------------------------

interface PluginRoutePolicy {
  capability: CoreCapability
  stepUp: boolean
}

function resolvePluginRoutePolicy(method: string, pathname: string): PluginRoutePolicy {
  // Fresh install / upgrade — uploads + executes arbitrary plugin code. RCE.
  if (method === 'POST' && pathname === '/admin/api/cms/plugins') {
    return { capability: 'plugins.install', stepUp: true }
  }
  if (method === 'POST' && pathname === '/admin/api/cms/plugins/package') {
    return { capability: 'plugins.install', stepUp: true }
  }
  if (method === 'POST' && pathname === '/admin/api/cms/plugins/inspect-package') {
    // Read-only — inspect a .zip before deciding to install. Same audience
    // as the install endpoint (someone deciding whether to run untrusted
    // code), but the operation itself never touches the host.
    return { capability: 'plugins.install', stepUp: false }
  }
  // Pack install — re-syncs a plugin's bundled modules/loops/VCs into the
  // draft site. Runs plugin code in the worker.
  if (method === 'POST' && PLUGIN_PACK_INSTALL_PATTERN.test(pathname)) {
    return { capability: 'plugins.install', stepUp: true }
  }

  // PATCH/DELETE on the item endpoint = enable/disable/uninstall.
  if (method === 'DELETE' && PLUGIN_ITEM_PATTERN.test(pathname)) {
    // Uninstall = the install endpoint's inverse; RCE-class risk if
    // forged (deletes plugin assets, runs the uninstall lifecycle hook).
    return { capability: 'plugins.install', stepUp: true }
  }
  if (method === 'PATCH' && PLUGIN_ITEM_PATTERN.test(pathname)) {
    // Enable / disable — runs activate / deactivate hooks; lifecycle.
    return { capability: 'plugins.lifecycle', stepUp: true }
  }
  if (method === 'POST' && PLUGIN_RESTART_PATTERN.test(pathname)) {
    return { capability: 'plugins.lifecycle', stepUp: true }
  }

  // Schedule mutations — run-now fires arbitrary plugin code immediately;
  // pause/resume change which schedules tick.
  if (method === 'POST' && PLUGIN_SCHEDULE_RUN_NOW_PATTERN.test(pathname)) {
    return { capability: 'plugins.lifecycle', stepUp: true }
  }
  if (method === 'POST' && PLUGIN_SCHEDULE_PAUSE_PATTERN.test(pathname)) {
    return { capability: 'plugins.lifecycle', stepUp: true }
  }
  if (method === 'POST' && PLUGIN_SCHEDULE_RESUME_PATTERN.test(pathname)) {
    return { capability: 'plugins.lifecycle', stepUp: true }
  }

  // Per-plugin settings — bounded by the plugin's own schema, but step-up
  // gated because settings changes fire the plugin's `settings.changed`
  // hook with the new values.
  if (method === 'PUT' && PLUGIN_SETTINGS_PATTERN.test(pathname)) {
    return { capability: 'plugins.configure', stepUp: true }
  }
  if (method === 'GET' && PLUGIN_SETTINGS_PATTERN.test(pathname)) {
    return { capability: 'plugins.configure', stepUp: false }
  }

  // Per-plugin records — bounded by the plugin's own resource schemas.
  // Read = `plugins.read`; write = `plugins.configure` (settings-class).
  if (PLUGIN_RECORD_ITEM_PATTERN.test(pathname) || PLUGIN_RECORDS_PATTERN.test(pathname)) {
    if (method === 'GET') return { capability: 'plugins.read', stepUp: false }
    return { capability: 'plugins.configure', stepUp: false }
  }

  // Read-only routes — collection list, schedules list, events SSE.
  // Anyone with the read cap can inspect plugin state.
  return { capability: 'plugins.read', stepUp: false }
}

// ---------------------------------------------------------------------------
// Route table
//
// Thin adapters map the route table's `(req, db, params, options, user)` shape
// onto each handler's native positional signature. Order mirrors the original
// dispatcher: exact paths and nested/specific patterns before the bare
// `/plugins/:id` item route. Multi-method paths (`/plugins` GET+POST,
// `/plugins/:id` PATCH+DELETE, `/plugins/:id/settings` GET+PUT, records
// GET+POST / PATCH+DELETE) are separate entries; the handlers keep their own
// internal method branch, so behaviour is byte-for-byte preserved and the
// route table simply 405s any method none of the entries claim.
// ---------------------------------------------------------------------------

const PLUGIN_ADMIN_PATH = '/admin/api/cms/plugins'

const PLUGIN_ROUTES: readonly Route<[CmsHandlerOptions, AuthUser]>[] = [
  { method: 'GET', pattern: PLUGIN_ADMIN_PATH, handler: (req, db, _p, _o, user) => handlePluginsCollection(req, db, user) },
  { method: 'POST', pattern: PLUGIN_ADMIN_PATH, handler: (req, db, _p, _o, user) => handlePluginsCollection(req, db, user) },
  { method: 'POST', pattern: `${PLUGIN_ADMIN_PATH}/inspect-package`, handler: (req) => handleInspectPackage(req) },
  { method: 'POST', pattern: `${PLUGIN_ADMIN_PATH}/package`, handler: (req, db, _p, options, user) => handlePackageInstall(req, db, options, user) },
  { method: 'POST', pattern: PLUGIN_PACK_INSTALL_PATTERN, handler: (req, db, p, options, user) => handlePluginPackInstall(req, db, options, user, p.id) },
  { method: 'GET', pattern: PLUGIN_SETTINGS_PATTERN, handler: (req, db, p, _o, user) => handlePluginSettings(req, db, user, p.id) },
  { method: 'PUT', pattern: PLUGIN_SETTINGS_PATTERN, handler: (req, db, p, _o, user) => handlePluginSettings(req, db, user, p.id) },
  { method: 'POST', pattern: PLUGIN_RESTART_PATTERN, handler: (req, db, p, options, user) => handlePluginRestart(req, db, options, user, p.id) },
  { method: 'POST', pattern: PLUGIN_SCHEDULE_RUN_NOW_PATTERN, handler: (req, db, p) => handlePluginScheduleRunNow(req, db, p.id, p.sid) },
  { method: 'POST', pattern: PLUGIN_SCHEDULE_PAUSE_PATTERN, handler: (req, db, p) => handlePluginSchedulePause(req, db, p.id, p.sid) },
  { method: 'POST', pattern: PLUGIN_SCHEDULE_RESUME_PATTERN, handler: (req, db, p) => handlePluginScheduleResume(req, db, p.id, p.sid) },
  { method: 'GET', pattern: PLUGIN_SCHEDULES_PATTERN, handler: (req, db, p) => handlePluginSchedulesList(req, db, p.id) },
  { method: 'GET', pattern: PLUGIN_EVENTS_PATH, handler: async (req) => handlePluginEventsStream(req) },
  { method: 'PATCH', pattern: PLUGIN_RECORD_ITEM_PATTERN, handler: (req, db, p) => handlePluginRecordItem(req, db, p.id, p.rid, p.rec) },
  { method: 'DELETE', pattern: PLUGIN_RECORD_ITEM_PATTERN, handler: (req, db, p) => handlePluginRecordItem(req, db, p.id, p.rid, p.rec) },
  { method: 'GET', pattern: PLUGIN_RECORDS_PATTERN, handler: (req, db, p) => handlePluginRecordsCollection(req, db, p.id, p.rid) },
  { method: 'POST', pattern: PLUGIN_RECORDS_PATTERN, handler: (req, db, p) => handlePluginRecordsCollection(req, db, p.id, p.rid) },
  { method: 'PATCH', pattern: PLUGIN_ITEM_DISPATCH_PATTERN, handler: (req, db, p, options, user) => handlePluginItem(req, db, options, user, p.id) },
  { method: 'DELETE', pattern: PLUGIN_ITEM_DISPATCH_PATTERN, handler: (req, db, p, options, user) => handlePluginItem(req, db, options, user, p.id) },
]

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handlePluginsRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  // Make sure the plugin worker host knows the current DbClient before any
  // worker-initiated `cms.storage.*` round-trip lands. Idempotent; the host
  // just stores the reference. Required because `activateInstalledServerPlugins`
  // (the canonical setter) only runs at boot and after disable/enable cycles —
  // without this call, a fresh install or upgrade would see api dispatches
  // fail with "no DbClient configured" until the next boot.
  setPluginWorkerDbClient(db)

  // Plugin runtime is a pass-through to the plugin's own server module — its
  // capability gating lives inside `handleServerPluginRuntimeRequest` because
  // the module decides which routes are public vs. authenticated. Matched
  // before the admin gate, for any method.
  if (PLUGIN_RUNTIME_PATTERN.test(pathname)) {
    return (
      (await handleServerPluginRuntimeRequest(req, db)) ??
      jsonResponse({ error: 'Plugin route not found' }, { status: 404 })
    )
  }

  // Per-route capability + step-up gate. See `resolvePluginRoutePolicy`
  // above for the matrix. Splits the old `plugins.manage` mega-cap into
  // `plugins.read / configure / install / lifecycle`. The gate runs BEFORE
  // dispatch (matching the original), so the resolved `user` rides the route
  // table as extra context.
  if (!isPluginAdminPath(pathname)) return null
  const policy = resolvePluginRoutePolicy(req.method, pathname)
  const user = await requireCapability(req, db, policy.capability)
  if (user instanceof Response) return user
  if (policy.stepUp) {
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }

  return runRouteTable(req, db, PLUGIN_ROUTES, options, user)
}

/**
 * Quick check that `pathname` is one of the plugin admin routes — the
 * runtime route is handled separately above. Centralising the prefix keeps
 * the dispatcher's auth gate from running on unrelated CMS paths.
 */
function isPluginAdminPath(pathname: string): boolean {
  if (pathname === '/admin/api/cms/plugins') return true
  if (pathname === '/admin/api/cms/plugins/inspect-package') return true
  if (pathname === '/admin/api/cms/plugins/package') return true
  return pathname.startsWith('/admin/api/cms/plugins/')
}
