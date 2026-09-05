/**
 * Public site routes — the tail of the dispatcher: the published page (or a
 * branch preview of it), the first-run redirect, and the designed 404 page.
 * Split out of `server/router.ts` so the dispatcher stays a route table.
 */
import type { ServerRuntime } from '../serverRuntime'
import {
  BRANCH_PREVIEW_EXIT_PATH,
  clearPreviewCookie,
  previewCookie,
  previewTokenFromPath,
  resolvePreviewCookie,
  resolvePreviewToken,
} from '../branches/previewLinks'
import { getSetupStatusCached } from '../repositories/setup'
import { setCookieHeader } from '../http'
import { renderBranchPreview } from './branchPreview'
import { renderNotFoundResponse, renderPublicResolution } from './publicRouter'

/**
 * Single entry for every visitor-facing HTML URL — stand-alone published
 * pages (`/about`), content rows rendered through their postType's entry
 * template (`/posts/hello-world`), and row-slug redirects.
 *
 * Resolution + render live in `server/publish/publicRouter.ts`.
 * `renderPublicResolution` handles the full request: Layer A disk
 * fast-path (pre-rendered static artefacts via `readArtefact`), then
 * `resolvePublicRoute`, then the live renderer + `applyPublishedHtmlPipeline`.
 */
export async function tryServePublicRoute(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  // A visitor holding a live preview cookie sees the branch's draft instead
  // of the published site. A missing route on the branch falls through to
  // the 404 page, never to main's published page at that path.
  const previewBranchId = await resolvePreviewCookie(req, runtime.db)
  if (previewBranchId) return await renderBranchPreview(runtime.db, previewBranchId, url)
  return await renderPublicResolution(runtime.db, url, runtime.uploadsDir)
}

/**
 * Enter or leave a branch preview. Entering validates the token, sets the
 * cookie, and lands on the site root; a dead token clears any stale cookie
 * and lands on the root as an ordinary visitor. Leaving clears the cookie.
 */
export async function tryServeBranchPreviewLink(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  if (pathname === BRANCH_PREVIEW_EXIT_PATH) {
    return setCookieHeader(redirectToRoot(), clearPreviewCookie(req))
  }
  const token = previewTokenFromPath(pathname)
  if (!token) return null
  const branchId = await resolvePreviewToken(runtime.db, token)
  return setCookieHeader(redirectToRoot(), branchId ? previewCookie(req, token) : clearPreviewCookie(req))
}

function redirectToRoot(): Response {
  return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } })
}

/**
 * On a fresh install with no admin user yet, bounce the visitor to /admin so
 * they land in the setup wizard instead of seeing a confusing 404. Returns
 * null when the install is already past setup.
 */
export async function trySetupRedirect(req: Request, runtime: ServerRuntime, _url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  // Sticky memo: once setup completes, this stops querying. Without it every
  // unmatched GET (bot probes, 404s) paid two COUNT queries forever.
  const setupStatus = await getSetupStatusCached(runtime.db)
  return setupStatus.needsSetup
    ? new Response(null, { status: 302, headers: { location: '/admin' } })
    : null
}

/**
 * Last route before the dispatcher's bare JSON 404: serve the site's designed
 * 404 page (the `notFound` template) for any GET no other route claimed.
 * Namespaced prefixes (`/admin/api/*`, `/_instatic/*`, `/uploads/*`) never
 * reach here — they absorb their namespace and emit their own 404s. Returns
 * null (→ JSON 404) when the published site has no notFound template.
 */
export async function tryServeNotFoundPage(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  return await renderNotFoundResponse(runtime.db, url, runtime.uploadsDir)
}
