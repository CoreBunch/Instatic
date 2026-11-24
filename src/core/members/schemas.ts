/**
 * Shapes for site members, shared by the server (`server/members/`), the
 * admin, and the published-page runtime.
 *
 * Members are people who sign up and log in on the published site. They are
 * not admin users: different tables, different cookie, no capabilities.
 */
import { Type, type Static } from '@sinclair/typebox'
import { safeParseValue } from '@core/utils/typeboxHelpers'

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

/** The id of a page of the site. */
const PageIdSchema = Type.String({ minLength: 1, maxLength: 120 })

/**
 * Owner-assigned pages, by page id, so renaming a page never breaks a link.
 * `login` is where a protected page sends a signed-out visitor. The rest
 * receive the links in account emails (`?token=…`); when one is unset, or
 * its page is not published, there is no page for that link and the feature
 * that would send it is switched off. Core serves no member page of its own.
 */
export const MemberPagesSchema = Type.Object(
  {
    login: Type.Optional(PageIdSchema),
    afterLogin: Type.Optional(PageIdSchema),
    verify: Type.Optional(PageIdSchema),
    reset: Type.Optional(PageIdSchema),
    magic: Type.Optional(PageIdSchema),
    invite: Type.Optional(PageIdSchema),
    emailChange: Type.Optional(PageIdSchema),
    /** Where a member approves an app that wants to sign them in. */
    appSignIn: Type.Optional(PageIdSchema),
    appPair: Type.Optional(PageIdSchema),
  },
  { additionalProperties: false },
)
export type MemberPages = Static<typeof MemberPagesSchema>
export type MemberPageKey = keyof MemberPages

/** The live address of each assigned page that is published. */
export type MemberPagePaths = Partial<Record<MemberPageKey, string>>

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

/** Tags under this prefix are the system's own; nobody can be granted one. */
const RESERVED_TAG_PREFIX = 'instatic:'

export function isGrantableMemberTag(tag: string): boolean {
  return new RegExp(MEMBER_TAG_PATTERN).test(tag) && !tag.startsWith(RESERVED_TAG_PREFIX)
}

/**
 * The rule a stored value falls back to when it is present but unreadable:
 * nobody gets in, and the route answers "not found". An access rule that
 * cannot be understood must never quietly become "anyone".
 */
export const LOCKED_ACCESS: AccessRule = {
  level: 'tags',
  tags: [`${RESERVED_TAG_PREFIX}locked`],
  onDeny: 'hide',
}

/**
 * Read a stored access rule. Absent means public. Present but invalid means
 * locked (see `LOCKED_ACCESS`), never public.
 */
export function parseAccessRule(raw: unknown): AccessRule {
  if (raw === undefined || raw === null) return PUBLIC_ACCESS
  const parsed = safeParseValue(AccessRuleSchema, raw)
  return parsed.ok ? parsed.value : LOCKED_ACCESS
}

/** Does a visitor with these tags (or `null` when signed out) pass `rule`? */
export function accessAllows(rule: AccessRule, memberTags: readonly string[] | null): boolean {
  if (rule.level === 'public') return true
  if (memberTags === null) return false
  if (rule.level === 'members') return true
  return rule.tags.some((tag) => memberTags.includes(tag))
}

// ─── Show-when rules ───────────────────────────────────────────────────────

/**
 * Which visitors an element is rendered for. Unlike an access rule this
 * protects nothing on its own: it only decides whether one element is part
 * of the page a visitor receives. It is evaluated on the server, so an
 * element a visitor may not see is never in their HTML.
 */
export const ShowWhenSchema = Type.Union([
  Type.Object({ visitor: Type.Literal('signedIn') }, { additionalProperties: false }),
  Type.Object({ visitor: Type.Literal('signedOut') }, { additionalProperties: false }),
  // A member who was sent here by an app that wants to sign them in, and a
  // member who was not. For the page where apps are approved.
  Type.Object({ visitor: Type.Literal('appAsking') }, { additionalProperties: false }),
  Type.Object({ visitor: Type.Literal('noAppAsking') }, { additionalProperties: false }),
  Type.Object(
    {
      visitor: Type.Literal('tags'),
      tags: Type.Array(Type.String({ pattern: MEMBER_TAG_PATTERN }), { minItems: 1, maxItems: 20 }),
    },
    { additionalProperties: false },
  ),
])
export type ShowWhen = Static<typeof ShowWhenSchema>

/** The node prop a show-when rule is stored under. */
export const SHOW_WHEN_PROP_KEY = 'showWhen'

/**
 * Read the show-when rule off a node's props. Absent means "everyone".
 * Present but unreadable means "nobody": a rule that cannot be understood
 * must never quietly show the element to all visitors.
 */
export function readShowWhen(props: Record<string, unknown>): ShowWhen | 'nobody' | null {
  const raw = props[SHOW_WHEN_PROP_KEY]
  if (raw === undefined || raw === null) return null
  const parsed = safeParseValue(ShowWhenSchema, raw)
  return parsed.ok ? parsed.value : 'nobody'
}

/** What a show-when rule looks at: the signed-in member behind a render. */
export interface ShowWhenVisitor {
  tags: readonly string[]
  /** The page was opened with an app's pending sign-in request. */
  appAsking: boolean
}

/** Is an element with `rule` rendered for this visitor (`null` when signed out)? */
export function showWhenAllows(rule: ShowWhen | 'nobody' | null, visitor: ShowWhenVisitor | null): boolean {
  if (rule === null) return true
  if (rule === 'nobody') return false
  if (rule.visitor === 'signedOut') return visitor === null
  if (visitor === null) return false
  switch (rule.visitor) {
    case 'signedIn':
      return true
    case 'appAsking':
      return visitor.appAsking
    case 'noAppAsking':
      return !visitor.appAsking
    case 'tags':
      return rule.tags.some((tag) => visitor.tags.includes(tag))
  }
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
  'not_available',
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
