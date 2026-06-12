/**
 * Login-attempt audit trail.
 *
 * Every authentication attempt — successful or not, against a known account or
 * not — produces one row here. Two callers:
 *
 *   1. The login handler logs the result of each attempt for forensic review
 *      and to give operators a "who tried to log in as foo@bar.com" feed.
 *   2. The per-account lockout policy in `server/auth/lockout.ts` is driven by
 *      `users.failed_login_count` (a fast running counter), but operators can
 *      still inspect the underlying attempt history via this table.
 *
 * The table is append-only by convention; cleanup (retention) is left to a
 * future change set when audit volume warrants it. Rows are tiny.
 *
 * @see server/db/migrations-pg.ts:001_baseline — column definitions
 * @see server/auth/lockout.ts                  — policy that consumes this
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'

export type LoginAttemptResult =
  | 'success'
  | 'bad_password'
  | 'no_user'
  | 'account_disabled'
  | 'locked'
  | 'rate_limited'
  | 'mfa_failed'

interface LoginAttempt {
  id: string
  attemptedAt: string
  emailNorm: string | null
  ipAddress: string | null
  userAgent: string | null
  userId: string | null
  result: LoginAttemptResult
}

interface LoginAttemptRow {
  id: string
  attempted_at: Date | string
  email_norm: string | null
  ip_address: string | null
  user_agent: string | null
  user_id: string | null
  result: LoginAttemptResult
}

function rowToAttempt(row: LoginAttemptRow): LoginAttempt {
  return {
    id: row.id,
    attemptedAt: new Date(row.attempted_at).toISOString(),
    emailNorm: row.email_norm,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    userId: row.user_id,
    result: row.result,
  }
}

export async function recordLoginAttempt(
  db: DbClient,
  input: {
    emailNorm: string | null
    ipAddress: string | null
    userAgent: string | null
    userId: string | null
    result: LoginAttemptResult
  },
): Promise<void> {
  await db`
    insert into login_attempts (id, email_norm, ip_address, user_agent, user_id, result)
    values (
      ${nanoid()},
      ${input.emailNorm},
      ${input.ipAddress},
      ${input.userAgent},
      ${input.userId},
      ${input.result}
    )
  `
}

export async function listLoginAttemptsForUser(
  db: DbClient,
  userId: string,
  limit = 50,
): Promise<LoginAttempt[]> {
  const { rows } = await db<LoginAttemptRow>`
    select id, attempted_at, email_norm, ip_address, user_agent, user_id, result
    from login_attempts
    where user_id = ${userId}
    order by attempted_at desc
    limit ${limit}
  `
  return rows.map(rowToAttempt)
}

/**
 * Per-account login activity feed. Combines:
 *
 *   - rows where `user_id = $userId` (post-lookup attempts — the user
 *     existed and the system identified the account)
 *   - rows where `email_norm = $emailNorm` and `user_id IS NULL` (pre-lookup
 *     attempts that mention this email but haven't been associated to a
 *     user — e.g. failed logins against a freshly suspended account, or
 *     attempts that hit the rate-limit / locked guards before the user-row
 *     lookup completed)
 *
 * The Activity tab on the Account page renders this feed so the user sees
 * "someone tried my email from a new IP" alongside their own successful
 * sessions.
 */
export async function listLoginActivityForUser(
  db: DbClient,
  userId: string,
  emailNorm: string,
  limit = 50,
): Promise<LoginAttempt[]> {
  const { rows } = await db<LoginAttemptRow>`
    select id, attempted_at, email_norm, ip_address, user_agent, user_id, result
    from login_attempts
    where user_id = ${userId}
       or (user_id is null and email_norm = ${emailNorm})
    order by attempted_at desc
    limit ${limit}
  `
  return rows.map(rowToAttempt)
}

export async function listLoginAttemptsForIp(
  db: DbClient,
  ipAddress: string,
  limit = 50,
): Promise<LoginAttempt[]> {
  const { rows } = await db<LoginAttemptRow>`
    select id, attempted_at, email_norm, ip_address, user_agent, user_id, result
    from login_attempts
    where ip_address = ${ipAddress}
    order by attempted_at desc
    limit ${limit}
  `
  return rows.map(rowToAttempt)
}
