/**
 * Visitor-auth configuration — read/write the single `visitor_auth_config` row.
 *
 * NOT stored in `site.settings_json`. `SiteSettingsSchema` is a closed
 * `Type.Object` and `parseSiteSettings` silently drops unknown keys, so a
 * `visitorAuth` field would not survive a publish/parse round-trip without
 * invasive core-type changes. A dedicated single-row config table is
 * cleaner, fully testable, and avoids touching the core settings type
 * system. See `docs/impl/SPEC-1-migrations.md` (deviation note).
 *
 * An in-memory cache front-ends the read: Phase-1 visitor auth is not
 * publish-versioned, so a manual reset on write (`resetVisitorAuthConfigCache`,
 * called by `saveVisitorAuthConfig`) is sufficient to keep every worker's
 * view consistent within one process.
 *
 * Phase 3 (D14/D15): the retired Phase-1/2 `protectedPrefixes` model is gone —
 * page access is now per-page (a `Page.access` field, see
 * `src/core/page-tree/page.ts`). The config now carries `defaultLandingPath`
 * (D15 fallback landing for a logged-in visitor with no primary-group landing).
 * The `024_page_access` migration added this column and backfilled the old
 * prefix config onto matching pages, then dropped `protected_prefixes_json`.
 */
import type { DbClient } from '../db/client'
import {
  DEFAULT_VISITOR_AUTH_CONFIG,
  VISITOR_AUTH_CONFIG_ROW_ID,
  type VisitorAuthConfig,
  type VisitorAuthConfigRow,
  type VisitorProfileField,
} from './types'

function rowToConfig(row: VisitorAuthConfigRow | undefined | null): VisitorAuthConfig {
  if (!row) return { ...DEFAULT_VISITOR_AUTH_CONFIG }
  return {
    enabled: Boolean(row.enabled),
    defaultLandingPath:
      typeof row.default_landing_path === 'string' && row.default_landing_path
        ? row.default_landing_path
        : DEFAULT_VISITOR_AUTH_CONFIG.defaultLandingPath,
    loginPath:
      typeof row.login_path === 'string' && row.login_path
        ? row.login_path
        : DEFAULT_VISITOR_AUTH_CONFIG.loginPath,
    registrationOpen: Boolean(row.registration_open),
    defaultRole:
      typeof row.default_role === 'string' && row.default_role
        ? row.default_role
        : DEFAULT_VISITOR_AUTH_CONFIG.defaultRole,
    profileFields: normalizeProfileFieldDefs(row.profile_fields_json),
  }
}

/**
 * Coerce a raw profile_fields_json config cell into a VisitorProfileField[].
 * Defensive against string | array | undefined and malformed entries so a
 * corrupt row never breaks config reads — bad entries are dropped.
 */
function normalizeProfileFieldDefs(raw: VisitorAuthConfigRow['profile_fields_json']): VisitorProfileField[] {
  let arr: unknown
  if (raw == null) return []
  if (typeof raw === 'string') { try { arr = JSON.parse(raw) } catch { return [] } } else { arr = raw }
  if (!Array.isArray(arr)) return []
  return arr.filter((f): f is VisitorProfileField =>
    !!f && typeof f === 'object' && typeof (f as VisitorProfileField).id === 'string'
  )
}

let cached: VisitorAuthConfig | null = null

/** Drop the cached config — call whenever the row is written. */
export function resetVisitorAuthConfigCache(): void {
  cached = null
}

/**
 * Read the visitor-auth config. The single `'default'` row is the source of
 * truth; a missing row (fresh install before the migration seeds, or a hand-
 * deleted row) resolves to `DEFAULT_VISITOR_AUTH_CONFIG` (disabled). The
 * parsed result is cached for the process; `saveVisitorAuthConfig` resets
 * the cache after a write.
 */
export async function getVisitorAuthConfig(db: DbClient): Promise<VisitorAuthConfig> {
  if (cached) return cached
  const { rows } = await db<VisitorAuthConfigRow>`
    select id, enabled, default_landing_path, login_path, registration_open, default_role, profile_fields_json, updated_at
    from visitor_auth_config
    where id = ${VISITOR_AUTH_CONFIG_ROW_ID}
    limit 1
  `
  cached = rowToConfig(rows[0])
  return cached
}

/**
 * UPSERT the config row: read current (or default), merge the patch, write
 * back, reset the cache, return the new config. The single row keeps the
 * write path simple — no partial-column UPDATE logic, just a full overwrite
 * of the merged value.
 *
 * Legacy `protectedPrefixes` is no longer a config field (retired in Phase 3);
 * callers that still send it are ignored silently by the schema.
 */
export async function saveVisitorAuthConfig(
  db: DbClient,
  patch: Partial<VisitorAuthConfig>,
): Promise<VisitorAuthConfig> {
  const current = await getVisitorAuthConfig(db)
  const next: VisitorAuthConfig = {
    ...current,
    ...patch,
    // Defensive: never let a caller blank out a required string field.
    loginPath: patch.loginPath?.trim() ? patch.loginPath.trim() : current.loginPath,
    defaultRole: patch.defaultRole?.trim() ? patch.defaultRole.trim() : current.defaultRole,
    defaultLandingPath:
      patch.defaultLandingPath !== undefined
        ? resolveLandingPath(patch.defaultLandingPath)
        : current.defaultLandingPath,
  }

  // UPSERT against the fixed `'default'` id. The row is seeded by the
  // migration, but a hand-deleted row must still be re-creatable here so
  // `saveVisitorAuthConfig` is the single write entrypoint.
  await db`
    insert into visitor_auth_config (id, enabled, default_landing_path, login_path, registration_open, default_role, profile_fields_json, updated_at)
    values (
      ${VISITOR_AUTH_CONFIG_ROW_ID},
      ${next.enabled},
      ${next.defaultLandingPath},
      ${next.loginPath},
      ${next.registrationOpen},
      ${next.defaultRole},
      ${JSON.stringify(next.profileFields ?? [])},
      current_timestamp
    )
    on conflict (id) do update
      set enabled = excluded.enabled,
          default_landing_path = excluded.default_landing_path,
          login_path = excluded.login_path,
          registration_open = excluded.registration_open,
          default_role = excluded.default_role,
          profile_fields_json = excluded.profile_fields_json,
          updated_at = current_timestamp
  `
  // Update the cache so a concurrent reader sees the just-persisted value
  // without a round-trip.
  cached = next
  return next
}

/** Resolve a landing path: fall back to the configured default when blank. */
function resolveLandingPath(path: string): string {
  const trimmed = path.trim()
  return trimmed || DEFAULT_VISITOR_AUTH_CONFIG.defaultLandingPath
}
