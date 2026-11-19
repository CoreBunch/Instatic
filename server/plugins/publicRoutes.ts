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
 *
 * A member route answers the member's browser (the session cookie). One the
 * plugin opened to apps (`{ app: { scope } }`) also answers an app the member
 * signed in to: `Authorization: Bearer <access token>`, when that sign-in
 * carries the scope `plugin:<pluginId>:<scope>`. The token never reaches the
 * plugin either, on any route and under any `Authorization` scheme
 * (`routeIo.ts` drops the header).
 */
import type { DbClient } from '../db/client'
import { isStateChangingMethod, originAllowed } from '../auth/security'
import { jsonResponse, readBytesWithLimit, RequestBodyTooLargeError } from '../http'
import { pluginAppScope } from '@core/members'
import { memberAppIssuer } from '../members/apps/protocol'
import { findMemberApp, findMemberAppAccess, touchMemberAppGrant } from '../members/apps/store'
import { originOk, resolveSignedInMember } from '../members/handlers'
import { findMemberById, toCurrentMember } from '../members/repository'
import { findPluginRouteAccess, runRouteInWorker } from './host/rpc'
import { hostPluginHasPermission } from './host/registry'
import type { SerializedApp, SerializedMember } from './protocol/messages'

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

/**
 * What a request's `Authorization` header says about who is calling.
 *
 * Only the `Bearer` scheme (any letter case) is an app's attempt: a site
 * behind HTTP Basic auth sends `Authorization: Basic …` with every request,
 * and those are the member's browser (null). For a Bearer header, `token` is
 * the credential when it has the shape of a token and '' otherwise: a token
 * nobody holds, so the request is refused rather than answered from the
 * session cookie that may ride along.
 *
 * This decides who is calling, not what the plugin sees: a token under any
 * other scheme opens nothing, and the handler is not handed it either
 * (`serializeRouteRequest` drops an `Authorization` header that names a
 * member app token, whatever the scheme and whichever route it reached).
 */
function bearerCredential(req: Request): { token: string } | null {
  const header = req.headers.get('authorization')
  const match = header === null ? null : /^bearer(?:\s+([\s\S]*))?$/i.exec(header)
  if (!match) return null
  const raw = (match[1] ?? '').trim()
  return { token: /^[A-Za-z0-9_-]{20,200}$/.test(raw) ? raw : '' }
}

type AppCaller = { member: SerializedMember; app: SerializedApp; grantId: string }

/**
 * Who an app's token speaks for on this route: the member, and the app.
 * A Response when the token is not good here: 401 for a token that is not
 * live, 403 for one whose sign-in does not carry the route's scope.
 */
async function appCaller(
  db: DbClient,
  req: Request,
  token: string,
  pluginId: string,
  appScope: string,
): Promise<AppCaller | Response> {
  const resource = memberAppIssuer(req)
  const access = token && resource ? await findMemberAppAccess(db, token, resource) : null
  const record = access ? await findMemberById(db, access.memberId) : null
  const registered = access ? await findMemberApp(db, access.appId) : null
  if (!access || !record || !registered) {
    return jsonResponse(
      { error: 'The access token is missing, expired or revoked' },
      { status: 401, headers: { ...PRIVATE, 'www-authenticate': 'Bearer error="invalid_token"' } },
    )
  }
  if (!access.scope.split(' ').includes(pluginAppScope(pluginId, appScope))) {
    return jsonResponse(
      { error: 'This app was not allowed to do that' },
      { status: 403, headers: { ...PRIVATE, 'www-authenticate': 'Bearer error="insufficient_scope"' } },
    )
  }
  const member = await toCurrentMember(db, record)
  return {
    member: { id: member.id, email: member.email, tags: member.tags, profile: member.profile },
    app: { id: registered.id, name: registered.name, scope: appScope },
    grantId: access.grantId,
  }
}

/** The request as the plugin gets it when an app calls: without the token. */
function withoutCredentials(req: Request): Request {
  const headers = new Headers(req.headers)
  headers.delete('authorization')
  headers.delete('cookie')
  return new Request(req, { headers })
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
  let app: SerializedApp | null = null
  if (route.access.kind === 'member') {
    const token = bearerCredential(req)?.token ?? null
    if (token !== null) {
      // An app is calling. Only a route the plugin opened to apps answers
      // one, and only under the scope it named.
      if (route.access.appScope === null) return refuse(403, 'This route does not answer apps')
      const caller = await appCaller(db, req, token, pluginId, route.access.appScope)
      if (caller instanceof Response) return caller
      member = caller.member
      app = caller.app
      request = withoutCredentials(request)
      await touchMemberAppGrant(db, caller.grantId)
    } else {
      // A member route acts for whoever holds the session cookie, so a write
      // must come from this site's own pages: the browser names its origin.
      if (isStateChangingMethod(req.method) && !originOk(req)) return refuse(403, 'Forbidden: invalid origin')
      member = await signedInMember(db, req)
      if (!member) return refuse(401, 'Sign in to continue')
    }
    if (route.access.tag !== null && !member.tags.includes(route.access.tag)) {
      return refuse(403, 'Your account cannot open this')
    }
  } else {
    // A public route may be a webhook (no Origin at all). A request that
    // does name an origin must name this site's.
    if (isStateChangingMethod(req.method) && !originAllowed(req)) return refuse(403, 'Forbidden: invalid origin')
    // An app's token sent here anyway is not handed to the handler: `serializeRouteRequest` drops it.
    member = pluginMayReadMembers(pluginId) ? await signedInMember(db, req) : null
  }

  const response = await runRouteInWorker({ pluginId, method: req.method, path: routePath, request, user: null, member, app })
  // What a plugin answers for one member must not be kept by a shared cache.
  if (member && !response.headers.has('cache-control')) response.headers.set('cache-control', PRIVATE['cache-control'])
  return response
}
