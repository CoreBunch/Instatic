/**
 * Per-visitor data resolver — the IDOR-safe identity source for the
 * `visitor.current` and `visitor.owned-rows` loop sources.
 *
 * The load-bearing security rule: **the visitor identity is derived solely
 * from the validated session cookie**, never from any value supplied by the
 * loop's filters, query, or path. Every call into this module constructs a
 * minimal synthetic Request carrying only the visitor session cookie and
 * hands it to the existing cached `validateVisitorSession` — so the
 * in-memory session cache, expiry checks, and touch-debounce are all reused
 * rather than re-implemented. No visitor id from request input is ever
 * trusted on a read path (see the architecture gate
 * `visitor-data-isolation.test.ts`).
 *
 * Loop sources receive the parsed cookie map (`ctx.request.cookies`) rather
 * than a `Request`; this module is the bridge between that map and the
 * Request-shaped session validator.
 */
import type { DbClient } from '../db/client'
import { VISITOR_SESSION_COOKIE_NAME } from './types'
import { validateVisitorSession } from './sessions'
import { findVisitorUserById } from './repositories'
import { findVisitorRoleById } from './roles'

/**
 * Build a minimal Request that carries a single visitor session cookie, so
 * the cached `validateVisitorSession` can be reused unchanged. Only the
 * `cookie` header is read by the validator; the URL/method are arbitrary.
 */
function requestFromCookies(cookies: Record<string, string>): Request {
  const token = cookies?.[VISITOR_SESSION_COOKIE_NAME]
  const req = new Request('http://instatic.local/visitor-resolve')
  // Set the header imperatively rather than via the Request init: some
  // environments (e.g. the test harness's happy-dom Request) strip a `cookie`
  // header supplied through the constructor's `headers` init, mirroring the
  // browser fetch spec's forbidden-header rule. The real Bun server's Request
  // accepts either form, but imperative `.set()` works in BOTH, so the
  // resolver behaves identically in production and tests.
  if (token) req.headers.set('cookie', `${VISITOR_SESSION_COOKIE_NAME}=${token}`)
  return req
}

/**
 * The resolved visitor for loop sources: the VisitorUser plus its role name
 * (resolved via a second lookup so the source consumer doesn't have to).
 * IDOR-safe — derived solely from the validated session cookie.
 */
export interface ResolvedVisitor {
  id: string
  displayName: string
  email: string
  roleId: string
  roleName: string | null
  profileFields: Record<string, unknown>
}

/**
 * Resolve the logged-in visitor from a cookie map. Returns the visitor with
 * role name + profile fields, or `null` when there is no cookie, no valid
 * session, or the visitor record no longer exists.
 *
 * This is the single entry point both loop sources use to obtain visitor
 * identity. It accepts ONLY a cookie map — never a visitor/user/owner id —
 * which is what makes it IDOR-safe by construction.
 */
export async function resolveVisitorFromCookie(
  db: DbClient,
  cookies: Record<string, string> | undefined,
): Promise<ResolvedVisitor | null> {
  if (!cookies) return null
  const session = await validateVisitorSession(db, requestFromCookies(cookies))
  if (!session) return null
  const user = await findVisitorUserById(db, session.userId)
  if (!user) return null
  const role = user.roleId ? await findVisitorRoleById(db, user.roleId) : null
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    roleId: user.roleId,
    roleName: role?.name ?? null,
    profileFields: user.profileFields,
  }
}
