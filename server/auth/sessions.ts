import { placeholder, type DbClient } from '../db/client'
import { rowToUser, USER_JOINED_COLUMNS, type AuthUser, type JoinedUserRow } from '../repositories/users'
import { deriveDeviceLabel } from './deviceLabel'

const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 30

/**
 * Debounce window for the per-request `last_seen_at` touch. Every authenticated
 * request used to fire an unconditional `update sessions set last_seen_at` —
 * a WAL-serialized write on SQLite, a hot-row lock on Postgres. The session
 * idle timeout is 30 days, so letting `last_seen_at` drift up to 30s stale is
 * functionally irrelevant; the in-memory tracker below collapses the write to
 * at most one per session per window.
 */
const LAST_SEEN_TOUCH_DEBOUNCE_MS = 30_000

/**
 * Hard cap on the tracker map so a long-running process that rotates through
 * many session hashes can't leak memory. When exceeded the map is cleared
 * wholesale — the only cost is one redundant `last_seen_at` write per active
 * session right after the reset.
 */
const LAST_SEEN_TRACKER_MAX_ENTRIES = 10_000

/** idHash -> epoch ms of the last `last_seen_at` write we issued for it. */
const lastSeenTouchedAt = new Map<string, number>()

interface SessionUserRow extends JoinedUserRow {
  session_mfa_passed_at: Date | string | null
}

interface SessionRotationRow {
  user_id: string
  expires_at: Date | string
  ip_address: string | null
  user_agent: string | null
  device_label: string
  mfa_passed_at: Date | string | null
  step_up_expires_at: Date | string | null
}

interface RotatedSession {
  expiresAt: Date
}

function sessionIdleCutoff(now = Date.now()): Date {
  return new Date(now - SESSION_IDLE_TIMEOUT_MS)
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export async function createSession(
  db: DbClient,
  input: {
    idHash: string
    userId: string
    expiresAt: Date
    ipAddress: string | null
    userAgent: string | null
    /**
     * Optional override for the device label. Falls back to a UA-derived
     * label, then the empty string. Empty is acceptable — the schema allows
     * it as a not-null sentinel and the UI renders "Unknown device".
     */
    deviceLabel?: string
    mfaPassedAt?: Date | null
    /**
     * Pre-open a step-up window on the row. Production code never sets
     * this at session creation — step-up is opened by `rotateSessionToken`
     * after a fresh password re-entry. Tests use it to skip the step-up
     * dance when verifying handlers that require a step-up gate.
     */
    stepUpExpiresAt?: Date | null
  },
): Promise<void> {
  const deviceLabel = input.deviceLabel ?? deriveDeviceLabel(input.userAgent)
  await db`
    insert into sessions (id_hash, user_id, expires_at, ip_address, user_agent, device_label, mfa_passed_at, step_up_expires_at)
    values (${input.idHash}, ${input.userId}, ${input.expiresAt}, ${input.ipAddress}, ${input.userAgent}, ${deviceLabel}, ${input.mfaPassedAt ?? null}, ${input.stepUpExpiresAt ?? null})
  `
}

async function findSessionUserRow(
  db: DbClient,
  idHash: string,
  now = Date.now(),
): Promise<SessionUserRow | null> {
  const idleCutoff = sessionIdleCutoff(now)
  const currentTime = new Date(now)
  // Joins through `sessions`, so it can't reuse the `queryUsers` FROM clause —
  // but it splices the same `USER_JOINED_COLUMNS` constant so the hydrated user
  // column list still lives in exactly one place.
  const { rows } = await db.unsafe<SessionUserRow>(
    `select ${USER_JOINED_COLUMNS},
            sessions.mfa_passed_at as session_mfa_passed_at
     from sessions
     join users on users.id = sessions.user_id
     join roles on roles.id = users.role_id
     left join media_assets on media_assets.id = users.avatar_media_id
     where sessions.id_hash = ${placeholder(db.dialect, 1)}
       and sessions.revoked_at is null
       and sessions.expires_at > ${placeholder(db.dialect, 2)}
       and sessions.last_seen_at > ${placeholder(db.dialect, 3)}
       and users.status = ${placeholder(db.dialect, 4)}
       and users.deleted_at is null
     limit 1`,
    [idHash, currentTime, idleCutoff, 'active'],
  )
  return rows[0] ?? null
}

export async function findUserBySessionHash(
  db: DbClient,
  idHash: string,
  now = Date.now(),
): Promise<AuthUser | null> {
  const row = await findSessionUserRow(db, idHash, now)
  if (!row) return null
  const user = rowToUser(row)
  if (user.mfaEnabled && row.session_mfa_passed_at == null) return null

  await touchSessionLastSeen(db, idHash, now)
  return user
}

/**
 * Update `sessions.last_seen_at` for an authenticated request, debounced to at
 * most once per `LAST_SEEN_TOUCH_DEBOUNCE_MS` per session. The first touch for
 * a hash always writes; subsequent touches inside the window are skipped. See
 * `LAST_SEEN_TOUCH_DEBOUNCE_MS` for why the staleness is harmless.
 */
async function touchSessionLastSeen(db: DbClient, idHash: string, now: number): Promise<void> {
  const lastTouched = lastSeenTouchedAt.get(idHash)
  if (lastTouched !== undefined && now - lastTouched < LAST_SEEN_TOUCH_DEBOUNCE_MS) return

  if (lastSeenTouchedAt.size >= LAST_SEEN_TRACKER_MAX_ENTRIES) lastSeenTouchedAt.clear()
  lastSeenTouchedAt.set(idHash, now)
  await db`
    update sessions
    set last_seen_at = current_timestamp
    where id_hash = ${idHash}
  `
}

export async function sessionRequiresMfa(db: DbClient, idHash: string): Promise<boolean> {
  const row = await findSessionUserRow(db, idHash)
  if (!row) return false
  const user = rowToUser(row)
  return user.mfaEnabled && row.session_mfa_passed_at == null
}

export async function findUserByPendingMfaSessionHash(
  db: DbClient,
  idHash: string,
): Promise<AuthUser | null> {
  const row = await findSessionUserRow(db, idHash)
  if (!row) return null
  const user = rowToUser(row)
  if (!user.mfaEnabled || row.session_mfa_passed_at != null) return null
  return user
}

export async function revokeSessionByHash(db: DbClient, idHash: string): Promise<void> {
  await db`
    update sessions
    set revoked_at = current_timestamp
    where id_hash = ${idHash}
  `
}

/**
 * Read the `step_up_expires_at` column for a single live session. Used by
 * `requireStepUp` in `authz.ts` to decide whether the cookie's owner is
 * inside their fresh re-auth window.
 *
 * Returns `null` when the session doesn't exist, has been revoked, or has
 * never had a step-up grant. Callers must treat null as "needs step-up".
 */
export async function getSessionStepUpExpiresAt(
  db: DbClient,
  idHash: string,
): Promise<Date | null> {
  const { rows } = await db<{ step_up_expires_at: Date | string | null }>`
    select step_up_expires_at
    from sessions
    where id_hash = ${idHash}
      and revoked_at is null
    limit 1
  `
  const value = rows[0]?.step_up_expires_at ?? null
  return value ? new Date(value) : null
}

export async function rotateSessionToken(
  db: DbClient,
  currentIdHash: string,
  input: {
    nextIdHash: string
    mfaPassedAt?: Date | null
    stepUpExpiresAt?: Date | null
  },
): Promise<RotatedSession | null> {
  return db.transaction(async (tx) => {
    const { rows } = await tx<SessionRotationRow>`
      select user_id,
             expires_at,
             ip_address,
             user_agent,
             device_label,
             mfa_passed_at,
             step_up_expires_at
      from sessions
      where id_hash = ${currentIdHash}
        and revoked_at is null
      limit 1
    `
    const current = rows[0]
    if (!current) return null

    await tx`
      update sessions
      set revoked_at = current_timestamp
      where id_hash = ${currentIdHash}
        and revoked_at is null
    `

    const mfaPassedAt = input.mfaPassedAt !== undefined
      ? input.mfaPassedAt
      : current.mfa_passed_at
    const stepUpExpiresAt = input.stepUpExpiresAt !== undefined
      ? input.stepUpExpiresAt
      : current.step_up_expires_at

    await tx`
      insert into sessions (
        id_hash,
        user_id,
        expires_at,
        ip_address,
        user_agent,
        device_label,
        mfa_passed_at,
        step_up_expires_at
      )
      values (
        ${input.nextIdHash},
        ${current.user_id},
        ${dateValue(current.expires_at)},
        ${current.ip_address},
        ${current.user_agent},
        ${current.device_label},
        ${mfaPassedAt},
        ${stepUpExpiresAt}
      )
    `

    return { expiresAt: dateValue(current.expires_at) }
  })
}

export async function markSessionMfaPassed(
  db: DbClient,
  idHash: string,
  passedAt: Date = new Date(),
): Promise<void> {
  await db`
    update sessions
    set mfa_passed_at = ${passedAt},
        last_seen_at = current_timestamp
    where id_hash = ${idHash}
      and revoked_at is null
  `
}
