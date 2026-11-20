/**
 * TypeBox schemas for the `cms.members.*` api-call arguments: looking a site
 * member up, inviting or creating one, asking whether the site can email
 * members, and granting or withdrawing the plugin's own tags.
 */
import { Type } from '@sinclair/typebox'
import { MEMBER_EMAIL_MAX_LENGTH, MEMBER_TAG_PATTERN } from '@core/members'

const MemberIdSchema = Type.String({ minLength: 1, maxLength: 64 })
const EmailSchema = Type.String({ minLength: 3, maxLength: MEMBER_EMAIL_MAX_LENGTH })
const TagSchema = Type.String({ pattern: MEMBER_TAG_PATTERN })

/** Exactly one of `id` or `email`. */
export const MembersGetArgsSchema = Type.Tuple([
  Type.Union([
    Type.Object({ id: MemberIdSchema }, { additionalProperties: false }),
    Type.Object({ email: EmailSchema }, { additionalProperties: false }),
  ]),
])

export const MembersInviteArgsSchema = Type.Tuple([
  Type.Object(
    { email: EmailSchema, tags: Type.Optional(Type.Array(TagSchema, { maxItems: 20 })) },
    { additionalProperties: false },
  ),
])

/** Same shape as an invitation: the address, and tags granted when they are not already. */
export const MembersEnsureArgsSchema = MembersInviteArgsSchema

export const MembersEmailStatusArgsSchema = Type.Tuple([])

/** Where the plugin left off (null from the start) and how many ids to return. */
export const MembersDeletedSinceArgsSchema = Type.Tuple([
  Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  Type.Object(
    { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) },
    { additionalProperties: false },
  ),
])

/** The VM-side id of the plugin's export provider (it runs through the filter dispatcher). */
export const MembersExportProviderArgsSchema = Type.Tuple([
  Type.Object({ filterId: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
])

export const MembersTagsGrantArgsSchema = Type.Tuple([
  MemberIdSchema,
  TagSchema,
  Type.Object(
    { expiresAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])) },
    { additionalProperties: false },
  ),
])

export const MembersTagsRevokeArgsSchema = Type.Tuple([MemberIdSchema, TagSchema])
