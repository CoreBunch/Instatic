/**
 * The public plugin mount: `/_instatic/plugins/<pluginId>/<path>`.
 *
 * Plugin routes meant for the published site are served here, outside
 * `/admin`: a plugin's public routes (webhooks, read endpoints) and its
 * member routes (only a signed-in site member reaches the handler).
 * Admin-facing routes (capability-gated, or any signed-in admin) stay on the
 * admin mount and answer 404 here.
 *
 * This is the one place plugin code learns who the site member is. The
 * session cookie itself never reaches a plugin (`routeIo.ts` strips it);
 * the host resolves the member and passes a plain record.
 */
import type { DbClient } from '../db/client'
import { isStateChangingMethod, originAllowed } from '../auth/security'
import { jsonResponse, readBytesWithLimit, RequestBodyTooLargeError } from '../http'
import { originOk, resolveSignedInMember } from '../members/handlers'
import { toCurrentMember } from '../members/repository'
import { findPluginRouteAccess, runRouteInWorker } from './host/rpc'
import { hostPluginHasPermission } from './host/registry'
import type { SerializedMember } from './protocol/messages'

export const PUBLIC_PLUGIN_PATH_PREFIX = '/_instatic/plugins/'

/** Bodies on the public mount are small: form posts, JSON, webhooks. */
const MAX_BODY_BYTES = 1024 * 1024

const PRIVATE = { 'cache-control': 'private, no-store' } as const

function refuse(status: number, error: string): Response {
  return jsonResponse({ error }, { status, headers: PRIVATE })
}

async function signedInMember(db: DbClient, req: Request): Promise<SerializedMember | null> {
  const current = await resolveSignedInMember(db, req)
  if (!current) return null
  const member = await toCurrentMember(db, current.member)
  return { id: member.id, email: member.email, tags: member.tags, profile: member.profile }
}

function pluginMayReadMembers(pluginId: string): boolean {
  return hostPluginHasPermission(pluginId, 'members.read')
}

export async function handlePublicPluginRouteRequest(req: Request, db: DbClient, url: URL): Promise<Response> {
  const rest = url.pathname.slice(PUBLIC_PLUGIN_PATH_PREFIX.length)
  const slash = rest.indexOf('/')
  let pluginId: string
  let routePath: string
  try {
    pluginId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash))
    routePath = decodeURIComponent(slash === -1 ? '/' : rest.slice(slash))
  } catch (_err) {
    // A malformed percent-escape names no route.
    return refuse(404, 'Plugin route not found')
  }

  const route = findPluginRouteAccess(pluginId, req.method, routePath)
  // Admin routes are not part of the public mount: answered exactly like a route that does not exist.
  if (!route || route.access.kind === 'capability' || route.access.kind === 'authenticated') {
    return refuse(404, 'Plugin route not found')
  }

  // Read the body here, counting the bytes that actually arrive, and hand
  // the route a request that holds exactly those bytes.
  let request = req
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = await readBytesWithLimit(req, MAX_BODY_BYTES)
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) return refuse(413, 'Request body too large')
      throw err
    }
    request = new Request(req.url, { method: req.method, headers: req.headers, body: bytes })
  }

  let member: SerializedMember | null
  if (route.access.kind === 'member') {
    // A member route acts for whoever holds the session cookie, so a write
    // must come from this site's own pages: the browser names its origin.
    if (isStateChangingMethod(req.method) && !originOk(req)) return refuse(403, 'Forbidden: invalid origin')
    member = await signedInMember(db, req)
    if (!member) return refuse(401, 'Sign in to continue')
    if (route.access.tag !== null && !member.tags.includes(route.access.tag)) {
      return refuse(403, 'Your account cannot open this')
    }
  } else {
    // A public route may be a webhook (no Origin at all). A request that
    // does name an origin must name this site's.
    if (isStateChangingMethod(req.method) && !originAllowed(req)) return refuse(403, 'Forbidden: invalid origin')
    member = pluginMayReadMembers(pluginId) ? await signedInMember(db, req) : null
  }

  const response = await runRouteInWorker({ pluginId, method: req.method, path: routePath, request, user: null, member })
  // What a plugin answers for one member must not be kept by a shared cache.
  if (member && !response.headers.has('cache-control')) response.headers.set('cache-control', PRIVATE['cache-control'])
  return response
}
