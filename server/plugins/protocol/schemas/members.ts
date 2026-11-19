/**
 * TypeBox schemas for the `cms.members.*` api-call arguments: looking a site
 * member up, inviting one, and granting or withdrawing the plugin's own tags.
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

export const MembersTagsGrantArgsSchema = Type.Tuple([
  MemberIdSchema,
  TagSchema,
  Type.Object(
    { expiresAt: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])) },
    { additionalProperties: false },
  ),
])

export const MembersTagsRevokeArgsSchema = Type.Tuple([MemberIdSchema, TagSchema])
