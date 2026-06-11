/**
 * One dispatcher for every `server/handlers/cms/*` route group.
 *
 * Before this module existed, three different paradigms matched `(method,
 * path)` → handler across the CMS handlers — two copy-pasted `matchRoute`
 * loops (auth, media) that had already DRIFTED on the 404-vs-405 decision,
 * plus a scatter of hand-rolled `pathname.match(REGEX)` if-ladders. The same
 * wrong-method request returned different status codes depending on which file
 * owned the route.
 *
 * `runRouteTable` is the single deep dispatcher. A route group declares a flat
 * `Route[]` table and hands it here; the dispatcher owns matching, central
 * named-param decoding, and the one correct 404-vs-405 rule:
 *
 *   - a request whose path matches some route but whose method matches none of
 *     them → 405 Method Not Allowed.
 *   - a request whose path matches no route → `null`, so the CMS entry point
 *     (`./index.ts`) can try the next route group and ultimately 404.
 *
 * Adding a route is one table entry. Parameterised paths use a `RegExp` with
 * NAMED capture groups (`(?<id>[^/]+)`); the dispatcher decodes each captured
 * value once via `decodeURIComponent` and hands the handler a `RouteParams`
 * map. String patterns match the pathname exactly and carry no params.
 *
 * The handler signature is `(req, db, params, ...extra)`. `extra` is whatever
 * per-request context a group threads through (e.g. `CmsHandlerOptions`, or a
 * pre-gated `AuthUser`) — the dispatcher forwards it verbatim, so a group that
 * needs no extra context simply omits it.
 */
import type { DbClient } from '../../db/client'
import { methodNotAllowed } from '../../http'

export type RouteParams = Record<string, string>

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

type RouteHandler<Extra extends unknown[]> = (
  req: Request,
  db: DbClient,
  params: RouteParams,
  ...extra: Extra
) => Promise<Response>

export interface Route<Extra extends unknown[]> {
  readonly method: HttpMethod
  /**
   * Exact-match pathname (no params) or a `RegExp` with named capture groups.
   * Named groups become decoded `RouteParams` keys.
   */
  readonly pattern: string | RegExp
  readonly handler: RouteHandler<Extra>
}

/**
 * Match `pathname` against a single pattern. Returns the decoded named params
 * on a hit (an empty object for string patterns), or `null` on a miss. Every
 * captured value is run through `decodeURIComponent` exactly once, here, so no
 * handler decodes its own path params.
 */
function matchPattern(pathname: string, pattern: string | RegExp): RouteParams | null {
  if (typeof pattern === 'string') {
    return pathname === pattern ? {} : null
  }
  const match = pathname.match(pattern)
  if (!match) return null
  const params: RouteParams = {}
  for (const [key, value] of Object.entries(match.groups ?? {})) {
    params[key] = value === undefined ? '' : decodeURIComponent(value)
  }
  return params
}

/**
 * Walk `routes` in order, dispatching the first entry whose pattern AND method
 * match. Remembers whether ANY route's pattern matched so the path-matched /
 * wrong-method case resolves to 405 in ONE place, while a total miss returns
 * `null` for the caller to fall through to the next route group.
 */
export async function runRouteTable<Extra extends unknown[]>(
  req: Request,
  db: DbClient,
  routes: readonly Route<Extra>[],
  ...extra: Extra
): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  let pathMatched = false
  for (const route of routes) {
    const params = matchPattern(pathname, route.pattern)
    if (params === null) continue
    pathMatched = true
    if (req.method !== route.method) continue
    return route.handler(req, db, params, ...extra)
  }
  return pathMatched ? methodNotAllowed() : null
}
