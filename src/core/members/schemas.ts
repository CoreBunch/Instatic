/**
 * Shapes for site members, shared by the server (`server/members/`), the
 * admin, and the published-page runtime.
 *
 * Members are people who sign up and log in on the published site. They are
 * not admin users: different tables, different cookie, no capabilities.
 */
import { Type, type Static } from '@sinclair/typebox'

// ─── Limits ────────────────────────────────────────────────────────────────

export const MEMBER_EMAIL_MAX_LENGTH = 254
/** Upper bound so a hostile body cannot make argon2 hash megabytes. */
export const MEMBER_PASSWORD_MAX_LENGTH = 256
export const MEMBER_TAG_PATTERN = '^[a-z0-9][a-z0-9._:-]{0,63}$'
const PROFILE_FIELD_ID_PATTERN = '^[a-z][a-zA-Z0-9_]{0,39}$'

// ─── Settings ──────────────────────────────────────────────────────────────

/** Who may create an account. `closed` is the default: the feature is off. */
export const MemberSignupModeSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('invite'),
  Type.Literal('closed'),
])
export type MemberSignupMode = Static<typeof MemberSignupModeSchema>

export const MemberProfileFieldTypeSchema = Type.Union([
  Type.Literal('text'),
  Type.Literal('textarea'),
  Type.Literal('checkbox'),
])

/** One owner-defined profile field. `id` is the form field name and binding key. */
export const MemberProfileFieldSchema = Type.Object(
  {
    id: Type.String({ pattern: PROFILE_FIELD_ID_PATTERN }),
    label: Type.String({ minLength: 1, maxLength: 80 }),
    type: MemberProfileFieldTypeSchema,
    required: Type.Boolean(),
  },
  { additionalProperties: false },
)
export type MemberProfileField = Static<typeof MemberProfileFieldSchema>

/** A site-relative path such as `/login`. Never an absolute URL. */
const SitePathSchema = Type.String({ maxLength: 300, pattern: '^/(?![/\\\\])[^\\s]*$' })

/**
 * Owner-assigned pages. `login` is where a protected page sends a signed-out
 * visitor. The rest receive the links in account emails (`?token=…`); when
 * one is unset the link goes to the bare core page instead.
 */
export const MemberPagesSchema = Type.Object(
  {
    login: Type.Optional(SitePathSchema),
    afterLogin: Type.Optional(SitePathSchema),
    verify: Type.Optional(SitePathSchema),
    reset: Type.Optional(SitePathSchema),
    magic: Type.Optional(SitePathSchema),
    invite: Type.Optional(SitePathSchema),
    emailChange: Type.Optional(SitePathSchema),
  },
  { additionalProperties: false },
)
export type MemberPages = Static<typeof MemberPagesSchema>

export const MemberSettingsSchema = Type.Object(
  {
    signupMode: MemberSignupModeSchema,
    profileFields: Type.Array(MemberProfileFieldSchema, { maxItems: 30 }),
    pages: MemberPagesSchema,
  },
  { additionalProperties: false },
)
export type MemberSettings = Static<typeof MemberSettingsSchema>

export const DEFAULT_MEMBER_SETTINGS: MemberSettings = {
  signupMode: 'closed',
  profileFields: [{ id: 'name', label: 'Name', type: 'text', required: false }],
  pages: {},
}

// ─── Profile values ────────────────────────────────────────────────────────

export const MemberProfileValueSchema = Type.Union([Type.String({ maxLength: 2000 }), Type.Boolean()])
export const MemberProfileSchema = Type.Record(Type.String(), MemberProfileValueSchema)
export type MemberProfile = Static<typeof MemberProfileSchema>

// ─── The member, as pages and scripts see it ───────────────────────────────

/** What `/_instatic/members/me` and member bindings expose. No secrets. */
export const CurrentMemberSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  emailVerified: Type.Boolean(),
  profile: MemberProfileSchema,
  tags: Type.Array(Type.String()),
  hasPassword: Type.Boolean(),
  createdAt: Type.String(),
})
export type CurrentMember = Static<typeof CurrentMemberSchema>

// ─── Access rules ──────────────────────────────────────────────────────────

/**
 * Who may open a page or a table's entry routes.
 *  - `public`: anyone (the default; stored as no rule at all)
 *  - `members`: any signed-in member
 *  - `tags`: a signed-in member holding at least one of `tags`
 *
 * `onDeny` decides what a visitor who is not allowed sees: `login` sends
 * them to the assigned login page, `hide` answers 404 so the page's
 * existence is not revealed.
 */
export const AccessRuleSchema = Type.Union([
  Type.Object({ level: Type.Literal('public') }, { additionalProperties: false }),
  Type.Object(
    {
      level: Type.Literal('members'),
      onDeny: Type.Union([Type.Literal('login'), Type.Literal('hide')]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      level: Type.Literal('tags'),
      tags: Type.Array(Type.String({ pattern: MEMBER_TAG_PATTERN }), { minItems: 1, maxItems: 20 }),
      onDeny: Type.Union([Type.Literal('login'), Type.Literal('hide')]),
    },
    { additionalProperties: false },
  ),
])
export type AccessRule = Static<typeof AccessRuleSchema>

export const PUBLIC_ACCESS: AccessRule = { level: 'public' }

/** Does a visitor with these tags (or `null` when signed out) pass `rule`? */
export function accessAllows(rule: AccessRule, memberTags: readonly string[] | null): boolean {
  if (rule.level === 'public') return true
  if (memberTags === null) return false
  if (rule.level === 'members') return true
  return rule.tags.some((tag) => memberTags.includes(tag))
}

// ─── Action results (JSON mode) ────────────────────────────────────────────

/**
 * Stable machine codes for a failed member action. Pages map them to their
 * own wording; `message` in the response is only a plain-English default.
 */
export const MEMBER_ERROR_CODES = [
  'invalid_input',
  'invalid_credentials',
  'signup_closed',
  'invite_required',
  'invalid_token',
  'weak_password',
  'email_taken',
  'reauth_required',
  'not_signed_in',
  'rate_limited',
  'email_unavailable',
  'forbidden_origin',
] as const
export type MemberErrorCode = (typeof MEMBER_ERROR_CODES)[number]

export const MemberActionErrorSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    /** The form field the problem belongs to, when there is one. */
    field: Type.Optional(Type.String()),
  }),
})
