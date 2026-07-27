/**
 * Post-login landing-path resolution (Phase 3 — D15).
 *
 * Extracted from the login handler so the resolution rule lives in exactly one
 * testable place and the handler stays under the module-size ceiling. The
 * browser runtime stays dumb: it just honours the resolved `redirect` the
 * handler returns in the login response body.
 *
 * Resolution priority (per D15):
 *   1. An explicit `?redirect=` query param (highest — covers the "tried to
 *      hit a gated page" bounce-back-after-auth case).
 *   2. The visitor's primary group's `landingPath`, when it is set and not `/`.
 *   3. The configured `defaultLandingPath` (defaulting to `/`).
 *
 * The primary-group landing + group row are loaded lazily (only when no
 * explicit redirect) so the common redirect-after-gated-hit path does no DB
 * work beyond the cookie mint that already happened.
 */
import type { DbClient } from '../db/client'
import { findVisitorGroupById, getVisitorPrimaryGroupId } from './groups'

/**
 * Resolve a visitor's post-login landing path.
 *
 * @param db          The DB client (used only when no explicit redirect).
 * @param req         The login request (read for its `?redirect=` query param).
 * @param userId      The freshly-authenticated visitor's id.
 * @param defaultLandingPath  The configured default landing (D15); `/` when blank.
 */
export async function resolveLoginRedirect(
  db: DbClient,
  req: Request,
  userId: string,
  defaultLandingPath: string,
): Promise<string> {
  const explicit = new URL(req.url).searchParams.get('redirect')?.trim() ?? ''
  if (explicit) return explicit

  const primaryGroupId = await getVisitorPrimaryGroupId(db, userId)
  if (primaryGroupId) {
    const primaryGroup = await findVisitorGroupById(db, primaryGroupId)
    if (primaryGroup && primaryGroup.landingPath && primaryGroup.landingPath !== '/') {
      return primaryGroup.landingPath
    }
  }

  return defaultLandingPath || '/'
}
