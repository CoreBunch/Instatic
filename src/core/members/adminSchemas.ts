/**
 * Shapes of the members admin API (`/admin/api/cms/members`): what the
 * Site members tab lists, shows and sends.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  MEMBER_EMAIL_MAX_LENGTH,
  MEMBER_TAG_PATTERN,
  MemberProfileSchema,
  MemberSettingsSchema,
} from './schemas'

/**
 * How a member stands, for the admin:
 *  - `active`: can sign in
 *  - `pending`: has an account that is not usable yet: invited and not
 *    accepted, or signed up and not confirmed
 *  - `suspended`: blocked from signing in; any open session is ended
 */
export const MemberAdminStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('pending'),
  Type.Literal('suspended'),
])
export type MemberAdminStatus = Static<typeof MemberAdminStatusSchema>

export const MemberListItemSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  /** The `name` profile field, when the member filled it in. */
  name: Type.String(),
  status: MemberAdminStatusSchema,
  /** Tags the member holds right now (expired grants left out). */
  tags: Type.Array(Type.String()),
  createdAt: Type.String(),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
})
export type MemberListItem = Static<typeof MemberListItemSchema>

export const MemberListResponseSchema = Type.Object({
  members: Type.Array(MemberListItemSchema),
  /** How many members match the search and filters. */
  matching: Type.Integer(),
  /** Pass as `offset` to read the next page. Null on the last one. */
  nextOffset: Type.Union([Type.Integer(), Type.Null()]),
  /** Every member, whatever the filters. */
  counts: Type.Object({
    all: Type.Integer(),
    active: Type.Integer(),
    pending: Type.Integer(),
    suspended: Type.Integer(),
  }),
  /** Every tag at least one member holds, most used first. */
  tags: Type.Array(Type.Object({ tag: Type.String(), count: Type.Integer() })),
})
export type MemberListResponse = Static<typeof MemberListResponseSchema>

/** One grant of a tag. A member can hold the same tag from several sources. */
export const MemberTagGrantSchema = Type.Object({
  tag: Type.String(),
  /** `admin`, or the id of the plugin that granted it. */
  source: Type.String(),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  expired: Type.Boolean(),
  createdAt: Type.String(),
})
export type MemberTagGrant = Static<typeof MemberTagGrantSchema>

/** An app the member is signed in to: one approval that is still live. */
export const MemberConnectedAppSchema = Type.Object({
  /** The approval; what a disconnect names. */
  id: Type.String(),
  name: Type.String(),
  device: Type.String(),
  connectedAt: Type.String(),
  /** Null until the app first uses its sign-in. */
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
})
export type MemberConnectedApp = Static<typeof MemberConnectedAppSchema>

export const MemberDetailSchema = Type.Object({
  member: MemberListItemSchema,
  emailVerified: Type.Boolean(),
  profile: MemberProfileSchema,
  grants: Type.Array(MemberTagGrantSchema),
  /** Devices the member is signed in on. */
  sessions: Type.Array(
    Type.Object({
      createdAt: Type.String(),
      lastSeenAt: Type.String(),
      ipAddress: Type.Union([Type.String(), Type.Null()]),
      userAgent: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  /** Apps the member is signed in to, newest first. */
  connectedApps: Type.Array(MemberConnectedAppSchema),
  /** The newest activity, newest first. */
  events: Type.Array(
    Type.Object({
      kind: Type.String(),
      createdAt: Type.String(),
      ipAddress: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
})
export type MemberDetail = Static<typeof MemberDetailSchema>

const TagSchema = Type.String({ pattern: MEMBER_TAG_PATTERN })

export const MemberInviteInputSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: MEMBER_EMAIL_MAX_LENGTH }),
    /** Tags the member holds from the moment they accept. */
    tags: Type.Optional(Type.Array(TagSchema, { maxItems: 20 })),
    /**
     * How the single-use link reaches the person: emailed by the site (the
     * default), or handed back to the admin to pass on themselves. `link`
     * is what makes an invitation possible before outgoing email is set up.
     */
    delivery: Type.Optional(Type.Union([Type.Literal('email'), Type.Literal('link')])),
  },
  { additionalProperties: false },
)
export type MemberInviteInput = Static<typeof MemberInviteInputSchema>

export const MemberTagInputSchema = Type.Object(
  {
    tag: TagSchema,
    /** When the grant ends, as an ISO date-time. Null or absent means never. */
    expiresAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
  },
  { additionalProperties: false },
)
export type MemberTagInput = Static<typeof MemberTagInputSchema>

export const MemberTagRemoveInputSchema = Type.Object(
  { tag: TagSchema, source: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
)

/** A page of the site, as the Member settings page pickers offer it. */
export const MemberPageOptionSchema = Type.Object({
  id: Type.String(),
  title: Type.String(),
  /** The page's address in the editor's draft. */
  path: Type.String(),
  /** Its live address, or null while the page is not published. */
  publishedPath: Type.Union([Type.String(), Type.Null()]),
  /** The member form actions found on the page. */
  formActions: Type.Array(Type.String()),
  /** The page's Access lets only signed-in members in (all of them, or those with a tag). */
  membersOnly: Type.Boolean(),
})
export type MemberPageOption = Static<typeof MemberPageOptionSchema>

export const MemberSettingsResponseSchema = Type.Object({
  settings: MemberSettingsSchema,
  /** Every ordinary page of the site, for the page pickers. */
  pageOptions: Type.Array(MemberPageOptionSchema),
  /**
   * Can the site email a link to a member right now? False until Email has a
   * connector and sender (or the server is a development one) and the site's
   * public address is known. Invitations need it.
   */
  mailAvailable: Type.Boolean(),
  /**
   * Can the site build a link into itself? False only when its public
   * address is unknown. An invitation link for the admin to pass on needs
   * this and nothing else.
   */
  linkAvailable: Type.Boolean(),
})
export type MemberSettingsResponse = Static<typeof MemberSettingsResponseSchema>

export const MemberDetailResponseSchema = Type.Object({ detail: MemberDetailSchema })
export const MemberInviteResponseSchema = Type.Object({
  member: MemberListItemSchema,
  /** `invited` for a new member, `resent` when the address already had a pending invitation. */
  outcome: Type.Union([Type.Literal('invited'), Type.Literal('resent')]),
  /** The invitation link, only when it was asked for with `delivery: 'link'`. It is not stored and not shown again. */
  link: Type.Optional(Type.String()),
})

// ─── Sign-in for apps ──────────────────────────────────────────────────────

/** A scope by name: a built-in one, or `plugin:<pluginId>:<name>`. The server checks it is on offer. */
const MemberAppScopeSchema = Type.String({ minLength: 1, maxLength: 200 })

/** A scope an owner can give an app, with the words a member reads for it. */
export const MemberAppScopeOptionSchema = Type.Object({
  scope: Type.String(),
  text: Type.String(),
  /** The plugin that declares it; absent for a built-in scope. */
  plugin: Type.Optional(Type.Object({ id: Type.String(), name: Type.String() })),
})
export type MemberAppScopeOption = Static<typeof MemberAppScopeOptionSchema>

/** An app the site owner registered, which may ask a member to sign in. */
export const MemberAppSchema = Type.Object({
  /** The client id the app sends when it asks. */
  id: Type.String(),
  name: Type.String(),
  /** Where the app may be sent back to after the member answers. */
  redirectUris: Type.Array(Type.String()),
  scopes: Type.Array(Type.String()),
  createdAt: Type.String(),
})
export type MemberApp = Static<typeof MemberAppSchema>

export const MemberAppListResponseSchema = Type.Object({
  apps: Type.Array(MemberAppSchema),
  /** What an app can be given on this site right now: the built-in scopes and those of active plugins. */
  availableScopes: Type.Array(MemberAppScopeOptionSchema),
})
export type MemberAppListResponse = Static<typeof MemberAppListResponseSchema>

export const CreateMemberAppBodySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 80 }),
    redirectUris: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 10 }),
    scopes: Type.Array(MemberAppScopeSchema, { minItems: 1, maxItems: 30 }),
  },
  { additionalProperties: false },
)
export type CreateMemberAppBody = Static<typeof CreateMemberAppBodySchema>
