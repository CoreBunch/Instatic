/**
 * Visitor-auth domain types, constants, and DB row shapes.
 *
 * The visitor system is intentionally isolated from the admin auth system:
 * different tables (`visitor_users` / `visitor_sessions` / …), a different
 * cookie name, a different code path. The only thing shared is a small
 * set of stateless crypto / rate-limit / lockout utilities from
 * `server/auth/` (see the import whitelist in `SPEC-3` / `docs/PRD.md` D3).
 *
 * The `*Row` interfaces match the `002_visitor_auth` migration columns
 * exactly (snake_case). The public `Visitor*` interfaces are the
 * camelCase domain shape the handlers and clients speak. Row → domain
 * conversion lives in `repositories.ts`.
 */

/** Cookie name — deliberately distinct from the admin session cookie. */
export const VISITOR_SESSION_COOKIE_NAME = 'instatic_visitor_session'

/** Absolute session lifetime (90 days). */
export const VISITOR_SESSION_ABSOLUTE_MS = 1000 * 60 * 60 * 24 * 90

/** Idle timeout (30 days, advisory — the absolute timeout is the hard cap). */
export const VISITOR_SESSION_IDLE_MS = 1000 * 60 * 60 * 24 * 30

/** Minimum visitor password length. */
export const VISITOR_PASSWORD_MIN = 8

/** Password-reset token lifetime (1 hour). Raw tokens are never persisted; only their SHA-256 hash is. */
export const VISITOR_PASSWORD_RESET_TTL_MS = 1000 * 60 * 60

/** The single row id used for the `visitor_auth_config` table. */
export const VISITOR_AUTH_CONFIG_ROW_ID = 'default'

/**
 * The fixed group id used by the Phase-3 `024_page_access` migration backfill.
 * When an upgraded install still carried Phase-1/2 `protected_prefixes_json`,
 * every prefix-matched page is converted to per-page access against a single
 * synthesized `members` group carrying this id. Kept as a named constant so
 * the migration + any diagnostic tooling reference one id.
 */
export const VISITOR_BACKFILL_MEMBERS_GROUP_ID = 'vis_group_members_backfill'

export interface VisitorRole {
  id: string
  name: string
  capabilities: string[]
  isSystem: boolean
  createdAt: string
  updatedAt: string
}

export type VisitorUserStatus = 'active' | 'suspended'

export interface VisitorUser {
  id: string
  email: string
  emailNormalized: string
  passwordHash: string
  displayName: string
  roleId: string
  /** D15: the visitor's designated primary group (drives login redirect). Nullable. */
  primaryGroupId: string | null
  status: VisitorUserStatus
  failedLoginCount: number
  lockedUntil: string | null
  createdAt: string
  updatedAt: string
  /** Custom profile field VALUES (object keyed by field id). Empty {} when no fields configured/set. */
  profileFields: Record<string, unknown>
}

export interface VisitorSession {
  idHash: string
  userId: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  revokedAt: string | null
  ipAddress: string | null
  userAgent: string | null
  deviceLabel: string
}

export interface VisitorAuthConfig {
  enabled: boolean
  /** D15: where a visitor with no primary-group landing path lands after login. */
  defaultLandingPath: string
  loginPath: string
  registrationOpen: boolean
  defaultRole: string
  /**
   * Site-builder-defined custom profile field DEFINITIONS (DataField[]).
   * Default [] = no custom profile fields (pre-framework behaviour).
   * Values live per-visitor in visitor_users.profile_fields_json.
   */
  profileFields: VisitorProfileField[]
}

/**
 * A site-builder-defined visitor profile field. A minimal projection of the
 * core DataField shape (id/label/type/required) — kept narrow intentionally
 * so the visitor surface doesn't drag in the full field-type union until a
 * field type beyond text/longText/select/boolean is actually needed.
 */
export type VisitorProfileFieldType = 'text' | 'longText' | 'select' | 'boolean'

export interface VisitorProfileField {
  id: string
  label: string
  type: VisitorProfileFieldType
  required?: boolean
  options?: { value: string; label: string }[]
}

export const DEFAULT_VISITOR_AUTH_CONFIG: VisitorAuthConfig = {
  enabled: false,
  defaultLandingPath: '/',
  loginPath: '/login',
  registrationOpen: true,
  defaultRole: 'member',
  profileFields: [],
}

/** Outcome of a login attempt — persisted to `visitor_login_attempts`. */
export type VisitorLoginAttemptResult =
  | 'success'
  | 'bad_password'
  | 'no_user'
  | 'locked'
  | 'rate_limited'
  | 'account_disabled'

// ---------------------------------------------------------------------------
// DB row shapes (snake_case — match the `002_visitor_auth` migration exactly)
// ---------------------------------------------------------------------------

export interface VisitorRoleRow {
  id: string
  name: string
  capabilities_json: unknown
  is_system: boolean | number
  created_at: Date | string
  updated_at: Date | string
}

export interface VisitorUserRow {
  id: string
  email: string
  email_normalized: string
  password_hash: string
  display_name: string
  role_id: string
  /** D15 primary group — nullable, references visitor_groups(id). */
  primary_group_id: string | null
  status: VisitorUserStatus | string
  failed_login_count: number
  locked_until: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  deleted_at: Date | string | null
  /** Custom profile field VALUES (object keyed by field id). Auto-parsed by the _json-suffix adapter. */
  profile_fields_json?: Record<string, unknown> | string
}

export interface VisitorSessionRow {
  id_hash: string
  user_id: string
  created_at: Date | string
  last_seen_at: Date | string
  expires_at: Date | string
  revoked_at: Date | string | null
  ip_address: string | null
  user_agent: string | null
  device_label: string
}

export interface VisitorLoginAttemptRow {
  id: string
  attempted_at: Date | string
  email_normalized: string | null
  ip_address: string | null
  user_agent: string | null
  user_id: string | null
  result: VisitorLoginAttemptResult | string
}

export interface VisitorAuthConfigRow {
  id: string
  enabled: boolean | number
  /** D15 default landing path (replaces the retired `protected_prefixes_json`). */
  default_landing_path: string
  login_path: string
  registration_open: boolean | number
  default_role: string
  updated_at: Date | string
  /** Site-builder-configured profile field DEFINITIONS (DataField[]). */
  profile_fields_json?: unknown
}

/**
 * A valid (unconsumed, unexpired) password-reset token lookup result.
 * `token_hash` is the SHA-256 hex of the raw token; the raw token is never
 * stored and is therefore never part of this shape.
 */
export interface VisitorPasswordResetToken {
  id: string
  userId: string
  tokenHash: string
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

/** DB row shape for `visitor_password_reset_tokens` (snake_case — matches the `022_visitor_password_reset` migration). */
export interface VisitorPasswordResetTokenRow {
  id: string
  user_id: string
  token_hash: string
  expires_at: Date | string
  used_at: Date | string | null
  created_at: Date | string
}

// ---------------------------------------------------------------------------
// Member groups (Phase 3 — D13/D14/D15)
// ---------------------------------------------------------------------------

/**
 * A member group — a content-segmentation segment used for page-level access
 * (D14) and login-redirect resolution (D15). Orthogonal to {@link VisitorRole}
 * (D13): a role answers "what can a member DO"; a group answers "what can a
 * member SEE / where do they land". A visitor belongs to 0..N groups via the
 * {@link VisitorUserGroup} junction, with one designated primary group
 * (`visitor_users.primary_group_id`).
 */
export interface VisitorGroup {
  id: string
  name: string
  /** Lowercase kebab, derived from the name. NOT unique (unlike `name`). */
  slug: string
  /** D15: where primary members of this group land after login. */
  landingPath: string
  description: string
  isSystem: boolean
  createdAt: string
  updatedAt: string
}

/** DB row shape for `visitor_groups` (snake_case — matches the `023_member_groups` migration). */
export interface VisitorGroupRow {
  id: string
  name: string
  slug: string
  landing_path: string
  description: string
  is_system: boolean | number
  created_at: Date | string
  updated_at: Date | string
}

/**
 * A membership row in the `visitor_user_groups` junction (D13). A visitor is
 * in a group at most once (UNIQUE(user_id, group_id)). Junction CASCADEs on
 * both sides, so deleting a group or a user removes its memberships.
 */
export interface VisitorUserGroup {
  id: string
  userId: string
  groupId: string
  createdAt: string
}

/** DB row shape for `visitor_user_groups` (snake_case — matches the `023_member_groups` migration). */
export interface VisitorUserGroupRow {
  id: string
  user_id: string
  group_id: string
  created_at: Date | string
}
