/**
 * Session + authorisation helper for the `/_instatic/gate/<nodeId>` endpoint.
 *
 * A gated container declares the member group ids that may view its subtree
 * (`base.container.authGate` — a `string[]` since Phase 3 / D16). The gate
 * endpoint reads the visitor session off the request cookie and asks this
 * helper whether the holder is a member of at least one of `requiredGroups`.
 *
 * Authorisation rule (Phase 3 / D16 — pure group-based; the Phase-2
 * role-based gate semantics are retired):
 *   - No session / expired / revoked session → NOT authorised (`anonymous`).
 *   - Session present but the visitor is not a member of ANY of the required
 *     groups → NOT authorised (`wrong_group`).
 *   - Otherwise → authorised (`ok`).
 *
 * Imports are read-only against the visitor-auth surface (sessions +
 * repositories + groups); this file owns no DB writes and mutates no visitor
 * state.
 */
import type { DbClient } from '../db/client'
import { validateVisitorSession } from './sessions'
import { listGroupIdsForVisitor } from './groups'

export interface GateAuthResult {
  authorized: boolean
  reason: 'anonymous' | 'wrong_group' | 'ok'
}

/**
 * Resolve whether the request's visitor session satisfies `requiredGroups`.
 *
 * Returns `{ authorized: true, reason: 'ok' }` when the session holder is a
 * member of at least one of the required groups. Returns
 * `{ authorized: false, reason: 'anonymous' }` when there is no valid
 * session, and `{ authorized: false, reason: 'wrong_group' }` when the
 * session exists but the visitor is in none of the required groups.
 *
 * A missing visitor record (deleted between login + request) is treated as
 * `anonymous` rather than thrown — there is no longer a session to honour.
 * An empty `requiredGroups` list authorises everyone (a not-gated container
 * never reaches the gate endpoint, but this keeps the helper total).
 */
export async function checkGateAccess(
  db: DbClient,
  req: Request,
  requiredGroups: string[],
): Promise<GateAuthResult> {
  if (requiredGroups.length === 0) return { authorized: true, reason: 'ok' }

  const session = await validateVisitorSession(db, req)
  if (!session) return { authorized: false, reason: 'anonymous' }

  const userGroupIds = await listGroupIdsForVisitor(db, session.userId)
  const allowed = requiredGroups.some((g) => userGroupIds.includes(g))
  return allowed
    ? { authorized: true, reason: 'ok' }
    : { authorized: false, reason: 'wrong_group' }
}
