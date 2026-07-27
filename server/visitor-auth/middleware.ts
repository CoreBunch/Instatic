/**
 * Visitor-auth route protection middleware (D1, D4, D6, D14, D17).
 *
 * Runs inside the server's main request try-block BEFORE `handleServerRequest`,
 * so it gates every public-site request (not just published-page renders).
 * Two jobs:
 *
 *   1. Built-in auth pages on direct visit. When visitor auth is enabled and a
 *      visitor GETs the configured `loginPath` (default `/login`) or the
 *      sibling `/register` path AND no published page exists at that path, the
 *      middleware serves the built-in login/register HTML inline. A published
 *      page always wins (so a builder who designs their own login page keeps
 *      it). This closes the "clicked a Login/Register link → 404" gap that the
 *      redirect-only fallback alone would leave on a fresh install.
 *
 *   2. Per-page access gating (D14 — replaces the Phase-1/2 protected-prefix
 *      model). The middleware resolves the published page at the path, reads
 *      its `access` level, and gates accordingly:
 *        - no published page → pass through (downstream 404)
 *        - public page → pass through
 *        - restricted (level 'groups') + anonymous → login (redirect to a
 *          published login page when one exists, else the built-in page)
 *        - restricted + logged-in-but-not-in-an-allowed-group → the built-in
 *          "no access" page (D17 — they're already signed in, so a redirect
 *          to login would loop; a 404 would hide the page's existence)
 *        - restricted + member of an allowed group → pass through
 *
 * Skip prefixes (`/_instatic/`, `/admin/`, `/health`, `/api/visitor/`,
 * `/uploads/`) keep the middleware off infrastructure and asset traffic so it
 * never interferes with admin, runtime assets, or the visitor API itself.
 */
import type { DbClient } from '../db/client'
import { getVisitorAuthConfig } from './config'
import { validateVisitorSession } from './sessions'
import { listGroupIdsForVisitor } from './groups'
import { getPublishedPageAccessForPath, publishedPageExistsAtPath } from '../publish/publicRouter'
import {
  BUILT_IN_LOGIN_PAGE_HTML,
  BUILT_IN_NO_ACCESS_PAGE_HTML,
  BUILT_IN_REGISTER_PAGE_HTML,
} from '../publish/visitorAuthRuntime'

/** Paths the middleware must never gate. */
const SKIP_PREFIXES = ['/_instatic/', '/admin/', '/health', '/api/visitor/', '/uploads/']

/** Built-in register page path (the login page links here). */
const BUILT_IN_REGISTER_PATH = '/register'

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Serve a built-in auth page on a direct GET when no published page exists at
 * that path. Returns the `Response` to short-circuit with, or `null` to let
 * the request continue.
 */
async function maybeServeBuiltInAuthPage(
  db: DbClient,
  pathname: string,
  loginPath: string,
): Promise<Response | null> {
  if (pathname !== loginPath && pathname !== BUILT_IN_REGISTER_PATH) return null
  if (await publishedPageExistsAtPath(db, pathname)) return null // a designed page wins
  if (pathname === loginPath) return htmlResponse(BUILT_IN_LOGIN_PAGE_HTML)
  return htmlResponse(BUILT_IN_REGISTER_PAGE_HTML)
}

/**
 * Build the anonymous-visitor login response for a restricted page. Prefer the
 * operator's published login page (302 redirect, so the browser address bar
 * shows the real URL and `?redirect=` round-trips the gated path for post-login
 * bounce-back); fall back to the built-in login page served inline so a fresh
 * install without a designed login page still works end-to-end.
 */
async function anonymousLoginResponse(
  db: DbClient,
  loginPath: string,
  pathname: string,
  search: string,
): Promise<Response> {
  if (await publishedPageExistsAtPath(db, loginPath)) {
    const redirect = encodeURIComponent(pathname + search)
    return new Response(null, {
      status: 302,
      headers: { location: `${loginPath}?redirect=${redirect}` },
    })
  }
  return htmlResponse(BUILT_IN_LOGIN_PAGE_HTML)
}

/**
 * Returns a `Response` to short-circuit the request with, or `null` to let
 * the request continue through the normal router.
 */
export async function visitorAuthMiddleware(req: Request, db: DbClient): Promise<Response | null> {
  const cfg = await getVisitorAuthConfig(db)
  if (!cfg.enabled) return null

  const url = new URL(req.url)
  const { pathname, search } = url

  // Never gate infrastructure / admin / visitor-API / asset traffic.
  if (SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null

  // Job 1: built-in login/register pages on direct visit (GET only).
  if (req.method === 'GET') {
    const builtIn = await maybeServeBuiltInAuthPage(db, pathname, cfg.loginPath)
    if (builtIn) return builtIn
  }

  // Job 2: per-page access gating (D14). No published page → pass through.
  const access = await getPublishedPageAccessForPath(db, pathname)
  if (!access) return null
  if (access.level === 'public') return null

  // Restricted (level 'groups'). Anonymous visitor → login.
  const session = await validateVisitorSession(db, req)
  if (!session) return anonymousLoginResponse(db, cfg.loginPath, pathname, search)

  // Logged in — check group membership. A member in ANY of the page's allowed
  // groups may view it (D14). Everyone else gets the D17 "no access" page; the
  // restricted content is never leaked to either branch.
  const userGroupIds = await listGroupIdsForVisitor(db, session.userId)
  const allowed = access.groups.some((g) => userGroupIds.includes(g))
  if (allowed) return null
  return htmlResponse(BUILT_IN_NO_ACCESS_PAGE_HTML)
}
