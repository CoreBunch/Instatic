/**
 * Session repository — read + revoke operations on the `sessions` table.
 *
 * `server/auth/sessions.ts` keeps the *write-side* (createSession,
 * findUserBySessionHash) and the sliding-window expiry math. This file owns
 * the user-facing operations: listing devices and revoking them. They live
 * here because they're CRUD over the row shape, not auth-decision logic.
 *
 * Cross-user safety: every mutation joins on `user_id` so a session id
 * belonging to another user cannot be revoked by passing its hash to one of
 * these functions. That's a defense-in-depth rule on top of the handler
 * pulling the user from the cookie before calling these.
 */
import type { DbClient } from '../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'

interface SessionListItem {
  id: string                       // sha256 hash of the cookie token (same as session.id_hash)
  deviceLabel: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  isCurrent: boolean               // true when id matches the request's session hash
  mfaPassedAt: string | null
  stepUpExpiresAt: string | null
}

interface SessionListRow {
  id_hash: string
  device_label: string
  ip_address: string | null
  user_agent: string | null
  created_at: Date | string
  last_seen_at: Date | string
  expires_at: Date | string
  mfa_passed_at: Date | string | null
  step_up_expires_at: Date | string | null
}

/**
 * List all live (non-revoked, non-expired) sessions for a user, newest
 * activity first. The current session — identified by `currentSessionHash` —
 * is flagged via `isCurrent: true` so the UI can pin it to the top of the
 * device list and disable the "Sign out" action on it.
 */
export async function listSessionsForUser(
  db: DbClient,
  userId: string,
  currentSessionHash: string | null,
  now: Date = new Date(),
): Promise<SessionListItem[]> {
  const { rows } = await db<SessionListRow>`
    select id_hash,
           device_label,
           ip_address,
           user_agent,
           created_at,
           last_seen_at,
           expires_at,
           mfa_passed_at,
           step_up_expires_at
    from sessions
    where user_id = ${userId}
      and revoked_at is null
      and expires_at > ${now}
    order by last_seen_at desc
  `
  return rows.map<SessionListItem>((row) => ({
    id: row.id_hash,
    deviceLabel: row.device_label || '',
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: isoDateOrNull(row.created_at)!,
    lastSeenAt: isoDateOrNull(row.last_seen_at)!,
    expiresAt: isoDateOrNull(row.expires_at)!,
    isCurrent: currentSessionHash !== null && row.id_hash === currentSessionHash,
    mfaPassedAt: isoDateOrNull(row.mfa_passed_at),
    stepUpExpiresAt: isoDateOrNull(row.step_up_expires_at),
  }))
}

/**
 * Revoke a single session by its hash, ONLY if it belongs to `userId`. The
 * `user_id = $userId` predicate is the cross-user guard — passing another
 * user's session hash returns 0 affected rows, never modifies anyone else's
 * row.
 *
 * Returns true when a row was actually updated, false otherwise (already
 * revoked, expired, belongs to another user, or doesn't exist).
 */
export async function revokeSessionByHashForUser(
  db: DbClient,
  sessionHash: string,
  userId: string,
): Promise<boolean> {
  const result = await db`
    update sessions
    set revoked_at = current_timestamp
    where id_hash = ${sessionHash}
      and user_id = ${userId}
      and revoked_at is null
  `
  return result.rowCount > 0
}

/**
 * Revoke every live session for `userId` EXCEPT the request's current
 * session. The current session is preserved so the user issuing the
 * "Sign out everywhere else" action doesn't immediately log themselves out.
 *
 * If `keepSessionHash` is null (caller couldn't identify the current
 * session — shouldn't happen in the normal flow), the operation revokes
 * EVERY session, which is the safe-but-harsh fallback.
 *
 * Returns the number of sessions revoked.
 */
export async function revokeAllOtherSessions(
  db: DbClient,
  userId: string,
  keepSessionHash: string | null,
): Promise<number> {
  if (keepSessionHash) {
    const result = await db`
      update sessions
      set revoked_at = current_timestamp
      where user_id = ${userId}
        and id_hash != ${keepSessionHash}
        and revoked_at is null
    `
    return result.rowCount
  }
  const result = await db`
    update sessions
    set revoked_at = current_timestamp
    where user_id = ${userId}
      and revoked_at is null
  `
  return result.rowCount
}
