/**
 * Visitor-auth DB CRUD — users, sessions, login attempts, password-reset
 * tokens.
 *
 * Visitor *roles* used to live here but were extracted into `./roles.ts`
 * (mirroring the admin system's `server/repositories/roles.ts` split) so
 * this file stays under the module-size ceiling. Import role symbols from
 * `./roles`.
 *
 * Mirrors the admin repositories (`server/repositories/{roles,users}.ts`)
 * but against the isolated `visitor_*` tables. All SQL is ANSI-standard
 * (no Postgres-isms: no `now()` in DML, no `::cast`, no `any($N::...)`,
 * no `distinct on`) so the same statements run unchanged against both the
 * Postgres and SQLite adapters. `current_timestamp` is the portable
 * "now" expression; absolute ISO strings are computed in JS for the
 * expiry-window comparisons (the `now` there is caller-supplied, not a
 * column default).
 *
 * Rows are mapped to camelCase domain interfaces through `rowTo*` helpers —
 * the only place that knows the snake_case column names is this module.
 * Column lists are inlined into each tagged template (matching
 * `server/repositories/roles.ts`) because a `db\`select ${COLS}\`` would
 * interpolate the constant as a bind parameter, not as SQL text.
 */
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import { createSessionToken, hashSessionToken } from '../auth/tokens'
import {
  VISITOR_PASSWORD_RESET_TTL_MS,
  type VisitorLoginAttemptResult,
  type VisitorPasswordResetToken,
  type VisitorPasswordResetTokenRow,
  type VisitorSession,
  type VisitorSessionRow,
  type VisitorUser,
  type VisitorUserRow,
  type VisitorUserStatus,
} from './types'

function rowToUser(row: VisitorUserRow): VisitorUser {
  return {
    id: row.id,
    email: row.email,
    emailNormalized: row.email_normalized,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    roleId: row.role_id,
    primaryGroupId: row.primary_group_id ?? null,
    status: row.status as VisitorUserStatus,
    failedLoginCount: Number(row.failed_login_count ?? 0),
    lockedUntil: isoDateOrNull(row.locked_until),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    profileFields: normalizeProfileFields(row.profile_fields_json),
  }
}

/**
 * Coerce a raw profile_fields_json cell (string | object | undefined) into a
 * plain object. The _json-suffix adapter auto-parses the column on read, but
 * this is defensive: raw migration SQL and the PG jsonb path may surface a
 * string, and a NULL-safe default of {} keeps callers branch-free.
 */
function normalizeProfileFields(raw: VisitorUserRow['profile_fields_json']): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} }
  }
  return raw as Record<string, unknown>
}

function rowToSession(row: VisitorSessionRow): VisitorSession {
  return {
    idHash: row.id_hash,
    userId: row.user_id,
    createdAt: new Date(row.created_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    revokedAt: isoDateOrNull(row.revoked_at),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    deviceLabel: row.device_label,
  }
}

function rowToPasswordResetToken(row: VisitorPasswordResetTokenRow): VisitorPasswordResetToken {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at).toISOString(),
    usedAt: isoDateOrNull(row.used_at),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * Lookup by normalized email, active (non-soft-deleted) only. The partial
 * unique index `visitor_users_email_active_idx` enforces uniqueness among
 * active rows, so at most one row matches.
 */
export async function findVisitorUserByEmailNormalized(
  db: DbClient,
  emailNormalized: string,
): Promise<VisitorUser | null> {
  const { rows } = await db<VisitorUserRow>`
    select id, email, email_normalized, password_hash, display_name, role_id, primary_group_id, status, failed_login_count, locked_until, created_at, updated_at, deleted_at, profile_fields_json
    from visitor_users
    where email_normalized = ${emailNormalized}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function findVisitorUserById(db: DbClient, id: string): Promise<VisitorUser | null> {
  const { rows } = await db<VisitorUserRow>`
    select id, email, email_normalized, password_hash, display_name, role_id, primary_group_id, status, failed_login_count, locked_until, created_at, updated_at, deleted_at, profile_fields_json
    from visitor_users
    where id = ${id}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function createVisitorUser(
  db: DbClient,
  input: {
    id: string
    email: string
    emailNormalized: string
    passwordHash: string
    displayName: string
    roleId: string
  },
): Promise<VisitorUser> {
  await db`
    insert into visitor_users (id, email, email_normalized, password_hash, display_name, role_id)
    values (${input.id}, ${input.email}, ${input.emailNormalized}, ${input.passwordHash}, ${input.displayName}, ${input.roleId})
  `
  const created = await findVisitorUserById(db, input.id)
  if (!created) throw new Error('[visitor-auth] visitor user insert did not return a row')
  return created
}

/** Reset the failed-login counter and clear any active lock on a successful login. */
export async function markVisitorUserLoggedIn(db: DbClient, id: string): Promise<void> {
  await db`
    update visitor_users
    set failed_login_count = 0,
        locked_until = ${null},
        updated_at = current_timestamp
    where id = ${id}
  `
}

/**
 * Bump the failed-login counter and (when a lockout was triggered) persist
 * the new `locked_until` deadline. Passing `lockedUntil: null` records the
 * failure without locking — the lockout decision is the caller's
 * (`evaluateFailedAttempt`).
 */
export async function recordVisitorFailedLogin(
  db: DbClient,
  id: string,
  lockedUntil: Date | null,
): Promise<void> {
  await db`
    update visitor_users
    set failed_login_count = failed_login_count + 1,
        locked_until = ${lockedUntil},
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
}

export async function setVisitorUserStatus(
  db: DbClient,
  id: string,
  status: VisitorUserStatus,
): Promise<void> {
  await db`
    update visitor_users
    set status = ${status},
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
}

/** Update only `display_name` — the single self-service field in Phase 1 (`PATCH /me`). */
export async function updateVisitorUserDisplayName(
  db: DbClient,
  id: string,
  displayName: string,
): Promise<VisitorUser | null> {
  await db`
    update visitor_users
    set display_name = ${displayName},
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
  return findVisitorUserById(db, id)
}

/**
 * Update a visitor's custom profile field VALUES (migration 025). Stores the
 * whole map — callers should merge against the current values first. Empty
 * object is valid (clears all profile fields).
 */
export async function updateVisitorUserProfileFields(
  db: DbClient,
  id: string,
  profileFields: Record<string, unknown>,
): Promise<VisitorUser | null> {
  await db`
    update visitor_users
    set profile_fields_json = ${JSON.stringify(profileFields)},
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
  return findVisitorUserById(db, id)
}

/**
 * Set a visitor's password hash. `visitor_users` has no `password_updated_at`
 * column (unlike the admin `users` table), so only `password_hash` +
 * `updated_at` are touched. Callers MUST `revokeAllVisitorSessionsForUser`
 * afterwards so the password change forces a fresh login.
 */
export async function updateVisitorUserPassword(
  db: DbClient,
  id: string,
  newPasswordHash: string,
): Promise<void> {
  await db`
    update visitor_users
    set password_hash = ${newPasswordHash},
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
}

// ─── Admin-facing read/management (used by /admin/api/cms/visitor-auth/*) ───

/**
 * Paginated list of active (non-soft-deleted) visitors, newest first.
 * Optional `search` does a case-insensitive LIKE on email or display name.
 * Mirrors the admin `listUsers` shape so the admin UI's user-management
 * table can reuse the same row contract.
 */
export async function listVisitorUsers(
  db: DbClient,
  options: { limit?: number; offset?: number; search?: string } = {},
): Promise<VisitorUser[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)
  const search = options.search?.trim().toLowerCase() ?? ''
  const pattern = search ? `%${search}%` : ''
  const { rows } = pattern
    ? await db<VisitorUserRow>`
        select id, email, email_normalized, password_hash, display_name, role_id, primary_group_id, status, failed_login_count, locked_until, created_at, updated_at, deleted_at, profile_fields_json
        from visitor_users
        where deleted_at is null
          and (lower(email) like ${pattern} or lower(display_name) like ${pattern})
        order by created_at desc
        limit ${limit} offset ${offset}
      `
    : await db<VisitorUserRow>`
        select id, email, email_normalized, password_hash, display_name, role_id, primary_group_id, status, failed_login_count, locked_until, created_at, updated_at, deleted_at, profile_fields_json
        from visitor_users
        where deleted_at is null
        order by created_at desc
        limit ${limit} offset ${offset}
      `
  return rows.map(rowToUser)
}

/** Total count of active visitors, optionally narrowed by the same search filter used by `listVisitorUsers` so the pagination total matches the filtered list. */
export async function countVisitorUsers(
  db: DbClient,
  options: { search?: string } = {},
): Promise<number> {
  const search = options.search?.trim().toLowerCase() ?? ''
  const pattern = search ? `%${search}%` : ''
  const { rows } = pattern
    ? await db<{ count: number }>`
        select count(*) as count
        from visitor_users
        where deleted_at is null
          and (lower(email) like ${pattern} or lower(display_name) like ${pattern})
      `
    : await db<{ count: number }>`
        select count(*) as count
        from visitor_users
        where deleted_at is null
      `
  return Number(rows[0]?.count ?? 0)
}

/** Reassign a visitor to a different visitor role. Validates the role exists. */
export async function updateVisitorUserRole(
  db: DbClient,
  id: string,
  roleId: string,
): Promise<VisitorUser | null> {
  await db`
    update visitor_users
    set role_id = ${roleId},
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
  return findVisitorUserById(db, id)
}

/**
 * Soft-delete a visitor (set `deleted_at`). The partial unique email index
 * only spans non-deleted rows, so the email can re-register afterwards.
 * Caller is responsible for revoking active sessions (see
 * `revokeAllVisitorSessionsForUser`).
 */
export async function softDeleteVisitorUser(db: DbClient, id: string): Promise<boolean> {
  const result = await db`
    update visitor_users
    set deleted_at = current_timestamp,
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
  return result.rowCount > 0
}

/**
 * GDPR self-service account deletion (V8). Wipes every PII column on the
 * visitor row, then soft-deletes it:
 *   - email / email_normalized → `'deleted+' || id` (stable, non-PII
 *     placeholder; the partial unique email index no longer covers it, so the
 *     original address can re-register)
 *   - display_name → ''
 *   - password_hash → '<invalidate>' (never matches any input — the row is
 *     dead anyway, but this guarantees no credential reuse)
 *   - status → 'suspended'
 *   - deleted_at / updated_at → now
 *
 * The row is KEPT (soft-delete) so FK integrity (visitor_sessions,
 * visitor_login_attempts, visitor_password_reset_tokens) and any audit
 * history stay intact. Also anonymizes the user's `visitor_login_attempts`
 * rows (email_normalized / ip_address / user_agent → null). Returns true only
 * when the visitor row was previously active (matched the `deleted_at is
 * null` guard) — a double-delete is a no-op returning false.
 */
export async function hardDeleteVisitorUser(db: DbClient, id: string): Promise<boolean> {
  const placeholder = `deleted+${id}`
  const result = await db`
    update visitor_users
    set email = ${placeholder},
        email_normalized = ${placeholder},
        display_name = '',
        password_hash = '<invalidate>',
        status = 'suspended',
        deleted_at = current_timestamp,
        updated_at = current_timestamp
    where id = ${id}
      and deleted_at is null
  `
  // Anonymize the user's login-attempt audit rows (PII columns) regardless
  // of whether the user row matched — idempotent and defense-in-depth.
  await db`
    update visitor_login_attempts
    set email_normalized = null,
        ip_address = null,
        user_agent = null
    where user_id = ${id}
  `
  return result.rowCount > 0
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface CreateVisitorSessionInput {
  idHash: string
  userId: string
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
  deviceLabel?: string
}

export async function createVisitorSession(
  db: DbClient,
  input: CreateVisitorSessionInput,
): Promise<VisitorSession> {
  const deviceLabel = input.deviceLabel ?? ''
  await db`
    insert into visitor_sessions (id_hash, user_id, expires_at, ip_address, user_agent, device_label)
    values (${input.idHash}, ${input.userId}, ${input.expiresAt}, ${input.ipAddress}, ${input.userAgent}, ${deviceLabel})
  `
  const created = await findActiveVisitorSessionByHash(db, input.idHash)
  if (!created) throw new Error('[visitor-auth] visitor session insert did not return a row')
  return created
}

/**
 * Active session lookup: hash match, not revoked, and not past `expires_at`.
 * `nowIso` is supplied by the caller so every comparison uses one clock read.
 */
export async function findActiveVisitorSessionByHash(
  db: DbClient,
  idHash: string,
  nowIso: string = new Date().toISOString(),
): Promise<VisitorSession | null> {
  const { rows } = await db<VisitorSessionRow>`
    select id_hash, user_id, created_at, last_seen_at, expires_at, revoked_at, ip_address, user_agent, device_label
    from visitor_sessions
    where id_hash = ${idHash}
      and revoked_at is null
      and expires_at > ${nowIso}
    limit 1
  `
  return rows[0] ? rowToSession(rows[0]) : null
}

/** Refresh `last_seen_at` — fire-and-forget from the session cache (debounced by the caller). */
export async function touchVisitorSession(
  db: DbClient,
  idHash: string,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  await db`
    update visitor_sessions
    set last_seen_at = ${nowIso}
    where id_hash = ${idHash}
      and revoked_at is null
  `
}

export async function revokeVisitorSessionByHash(db: DbClient, idHash: string): Promise<void> {
  await db`
    update visitor_sessions
    set revoked_at = current_timestamp
    where id_hash = ${idHash}
      and revoked_at is null
  `
}

export async function revokeAllVisitorSessionsForUser(db: DbClient, userId: string): Promise<void> {
  await db`
    update visitor_sessions
    set revoked_at = current_timestamp
    where user_id = ${userId}
      and revoked_at is null
  `
}

// ---------------------------------------------------------------------------
// Login attempts (audit trail — no auth decision hinges on this table in Phase 1)
// ---------------------------------------------------------------------------

interface RecordVisitorLoginAttemptInput {
  emailNormalized?: string | null
  ipAddress?: string | null
  userAgent?: string | null
  userId?: string | null
  result: VisitorLoginAttemptResult
}

export async function recordVisitorLoginAttempt(
  db: DbClient,
  input: RecordVisitorLoginAttemptInput,
): Promise<void> {
  await db`
    insert into visitor_login_attempts (id, attempted_at, email_normalized, ip_address, user_agent, user_id, result)
    values (
      ${nanoid()},
      current_timestamp,
      ${input.emailNormalized ?? null},
      ${input.ipAddress ?? null},
      ${input.userAgent ?? null},
      ${input.userId ?? null},
      ${input.result}
    )
  `
}

/**
 * Delete login-attempt rows older than `olderThanDays`. Call site is optional
 * in Phase 1 (the table is append-only until a cleanup job is wired); kept
 * here so a future cron has one canonical purge query.
 */
export async function purgeOldVisitorLoginAttempts(
  db: DbClient,
  olderThanDays = 90,
): Promise<void> {
  const cutoffIso = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
  await db`
    delete from visitor_login_attempts
    where attempted_at < ${cutoffIso}
  `
}

// ---------------------------------------------------------------------------
// Password reset tokens (Phase 2 — V7)
// ---------------------------------------------------------------------------

/**
 * Mint a one-shot password-reset token for `userId`. Returns the RAW token
 * (base64url, 32 random bytes) so the caller can hand it to the email
 * transport — the DB persists only its SHA-256 hash (`hashSessionToken`),
 * mirroring the session-token storage pattern. A token is invalid once
 * consumed (`used_at`) or past `expires_at` (1h TTL, see
 * `VISITOR_PASSWORD_RESET_TTL_MS`).
 */
export async function createPasswordResetToken(
  db: DbClient,
  userId: string,
): Promise<string> {
  const rawToken = createSessionToken() // randomBytes(32) base64url
  const tokenHash = await hashSessionToken(rawToken) // SHA-256 hex
  const expiresAt = new Date(Date.now() + VISITOR_PASSWORD_RESET_TTL_MS).toISOString()
  await db`
    insert into visitor_password_reset_tokens (id, user_id, token_hash, expires_at)
    values (${nanoid()}, ${userId}, ${tokenHash}, ${expiresAt})
  `
  return rawToken
}

/**
 * Look up a token by its hash. Only matches rows that are unused (`used_at
 * is null`) and not yet expired (`expires_at > now`). `nowIso` is supplied by
 * the caller so the freshness check uses one clock read. Returns `null` for
 * unknown / consumed / expired tokens — callers surface a single
 * `invalid_or_expired_token` error so the failure mode reveals nothing.
 */
export async function findValidPasswordResetToken(
  db: DbClient,
  tokenHash: string,
  nowIso: string = new Date().toISOString(),
): Promise<VisitorPasswordResetToken | null> {
  const { rows } = await db<VisitorPasswordResetTokenRow>`
    select id, user_id, token_hash, expires_at, used_at, created_at
    from visitor_password_reset_tokens
    where token_hash = ${tokenHash}
      and used_at is null
      and expires_at > ${nowIso}
    limit 1
  `
  return rows[0] ? rowToPasswordResetToken(rows[0]) : null
}

/**
 * Atomically consume a token (set `used_at`). Idempotent: the `where used_at
 * is null` guard means only the first caller wins. Returns true when this
 * call performed the consume (`rowCount > 0`); false when the token was
 * already consumed (concurrent reset race) or doesn't exist. The reset
 * handler treats a `false` result as `invalid_or_expired_token`.
 */
export async function consumePasswordResetToken(
  db: DbClient,
  tokenHash: string,
): Promise<boolean> {
  const result = await db`
    update visitor_password_reset_tokens
    set used_at = current_timestamp
    where token_hash = ${tokenHash}
      and used_at is null
  `
  return result.rowCount > 0
}
