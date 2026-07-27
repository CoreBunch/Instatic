/**
 * Members widget reader — total active registered visitors + a dense
 * 28-day registration histogram (one bucket per calendar day of new
 * sign-ups) plus the visitor-auth toggle states so the widget can show
 * whether auth / registration are currently on.
 *
 * Mirrors `readPostsStats`'s shape (count + trailing-28-day histogram)
 * but against the `visitor_users` table instead of `data_rows`.
 *
 * Self-contained on purpose: the `visitor_*` tables are owned by the
 * visitor-auth module (`server/visitor-auth/*`), which another agent
 * edits in parallel. Importing its repository layer would couple this
 * dashboard reader to a file that may move under us, so the three small
 * queries here hit `visitor_users` / `visitor_auth_config` directly. The
 * column names are stable (migration-locked snake_case), and the bucket
 * math reuses the same timezone-aware helpers as `posts.ts`.
 */
import type { DbClient } from '../../../db/client'
import { localDayKeyFactory } from '../../../time'
import { coerceCount } from './shared'
import type { DashboardRequestContext, MembersStats } from './types'

const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const HISTOGRAM_DAYS = 28

/**
 * `visitor_auth_config` ships a single seeded `'default'` row; a missing
 * row (fresh install before the seed migration, or a hand-deleted row)
 * resolves to "disabled / registration open" — the same defaults the
 * visitor-auth reader falls back to (`DEFAULT_VISITOR_AUTH_CONFIG`).
 * Kept inline here so this reader has zero runtime coupling to the
 * visitor-auth module's in-memory config cache.
 */
const MISSING_CONFIG = { authEnabled: false, registrationOpen: true } as const

export async function readMembersStats(
  db: DbClient,
  _options: unknown,
  ctx: DashboardRequestContext,
): Promise<MembersStats> {
  const dayKeyOf = localDayKeyFactory(ctx.timeZone)
  const sinceIso = new Date(Date.now() - TWENTY_EIGHT_DAYS_MS).toISOString()

  // Total count + the histogram source rows + the auth config read are
  // independent — fan them out in parallel so the endpoint resolves at
  // the slowest query, not their sum.
  const [total, registrations, config] = await Promise.all([
    readActiveVisitorTotal(db),
    readRecentRegistrations(db, sinceIso),
    readAuthConfig(db),
  ])

  // Bin each `created_at` into the viewer's local calendar day, then
  // densify into [28] oldest-first — identical to `readPostsStats`'s
  // trailing-28-day fill so the widget renders bars without gaps and
  // "today" lines up with the operator's day, not UTC's.
  const counts = new Map<string, number>()
  for (const createdAt of registrations) {
    const day = dayKeyOf(createdAt)
    counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  const daily28 = Array.from({ length: HISTOGRAM_DAYS }, (_, i) => {
    const d = new Date(Date.now() - (HISTOGRAM_DAYS - 1 - i) * DAY_MS)
    return counts.get(dayKeyOf(d)) ?? 0
  })

  const { authEnabled, registrationOpen } = config ?? MISSING_CONFIG
  return { total, daily28, authEnabled, registrationOpen }
}

/**
 * Count active (non-soft-deleted) visitors — the widget's headline number.
 * Mirrors the `deleted_at is null` guard every visitor-auth read uses, so
 * soft-deleted / GDPR-anonymized rows never inflate the total.
 */
async function readActiveVisitorTotal(db: DbClient): Promise<number> {
  const { rows } = await db<{ count: number | string }>`
    select count(*) as count
    from visitor_users
    where deleted_at is null
  `
  return coerceCount(rows[0]?.count)
}

/**
 * Raw `created_at` rows for every active visitor who registered inside the
 * 28-day window. The caller bins them per local calendar day client-side —
 * the day boundary depends on the viewer's timezone, which the database
 * can't know (see `server/time.ts` for the full rationale). Cardinality is
 * bounded by the trailing-28-day window, comfortably small.
 */
async function readRecentRegistrations(
  db: DbClient,
  sinceIso: string,
): Promise<Array<string | Date>> {
  const { rows } = await db<{ created_at: string | Date }>`
    select created_at
    from visitor_users
    where deleted_at is null
      and created_at >= ${sinceIso}
  `
  return rows.map((r) => r.created_at)
}

/**
 * Read the visitor-auth toggles straight from the single config row.
 * Returns `null` when the row is absent so the caller falls back to the
 * "disabled" default. SQLite stores booleans as 0/1 ints; both adapters
 * may hand back a number here, so coerce via `Boolean()` the same way the
 * visitor-auth reader's `rowToConfig` does.
 */
async function readAuthConfig(
  db: DbClient,
): Promise<{ authEnabled: boolean; registrationOpen: boolean } | null> {
  const { rows } = await db<{ enabled: boolean | number; registration_open: boolean | number }>`
    select enabled, registration_open
    from visitor_auth_config
    limit 1
  `
  const row = rows[0]
  if (!row) return null
  return {
    authEnabled: Boolean(row.enabled),
    registrationOpen: Boolean(row.registration_open),
  }
}
