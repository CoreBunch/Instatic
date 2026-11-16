/**
 * Wire shapes for the site's outgoing mail settings, shared by the server
 * handlers (`server/handlers/cms/mail.ts`) and the admin Email settings.
 *
 * The SMTP password only ever travels browser → server. No response shape in
 * this file carries it: the view reports `hasPassword` instead.
 */
import { Type, type Static } from '@sinclair/typebox'

/** Header-safe single line: no CR or LF, so a value can never add a header. */
const SINGLE_LINE = '^[^\\r\\n]*$'

/** Deliberately loose: one `@`, no spaces or line breaks. SMTP is the real judge. */
export const MAIL_ADDRESS_PATTERN = '^[^\\s@]+@[^\\s@]+$'

export const MailAddressSchema = Type.String({
  minLength: 3,
  maxLength: 320,
  pattern: MAIL_ADDRESS_PATTERN,
})

/**
 * How the server delivers mail right now.
 *  - `smtp`: an account is saved; mail is sent through it.
 *  - `capture`: nothing is saved and this is a development server; mail is
 *    written to the outbox (with its body) instead of leaving the machine.
 *  - `off`: nothing is saved on a production server; sending fails.
 */
export const MailDeliveryModeSchema = Type.Union([
  Type.Literal('smtp'),
  Type.Literal('capture'),
  Type.Literal('off'),
])
export type MailDeliveryMode = Static<typeof MailDeliveryModeSchema>

export const MailAccountSchema = Type.Object({
  host: Type.String(),
  port: Type.Integer(),
  username: Type.String(),
  hasPassword: Type.Boolean(),
  /** The stored password was encrypted with a different server secret key. */
  passwordNeedsReentry: Type.Boolean(),
  fromAddress: Type.String(),
  fromName: Type.String(),
  updatedAt: Type.String(),
})
export type MailAccount = Static<typeof MailAccountSchema>

export const MailSettingsViewSchema = Type.Object({
  mode: MailDeliveryModeSchema,
  account: Type.Union([MailAccountSchema, Type.Null()]),
  /**
   * The configured public origin links in emails are built from, or null when
   * none is configured (links cannot be built safely from the Host header).
   */
  publicOrigin: Type.Union([Type.String(), Type.Null()]),
  /** The operator allowed private-network SMTP relays (`MAIL_ALLOW_PRIVATE_HOSTS`). */
  privateHostsAllowed: Type.Boolean(),
})
export type MailSettingsView = Static<typeof MailSettingsViewSchema>

export const MailSettingsInputSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    username: Type.String({ maxLength: 320, pattern: SINGLE_LINE }),
    /** Omitted keeps the stored password; an empty string clears it. */
    password: Type.Optional(Type.String({ maxLength: 1024 })),
    fromAddress: MailAddressSchema,
    fromName: Type.String({ maxLength: 120, pattern: SINGLE_LINE }),
  },
  { additionalProperties: false },
)
export type MailSettingsInput = Static<typeof MailSettingsInputSchema>

export const MailTestInputSchema = Type.Object(
  { to: MailAddressSchema },
  { additionalProperties: false },
)

export const MailOutboxStatusSchema = Type.Union([
  Type.Literal('sent'),
  Type.Literal('failed'),
  Type.Literal('captured'),
])
export type MailOutboxStatus = Static<typeof MailOutboxStatusSchema>

export const MailOutboxEntrySchema = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  to: Type.String(),
  subject: Type.String(),
  status: MailOutboxStatusSchema,
  error: Type.Union([Type.String(), Type.Null()]),
  /** Present only for mail captured on a development server. */
  body: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})
export type MailOutboxEntry = Static<typeof MailOutboxEntrySchema>

export const MailOutboxResponseSchema = Type.Object({
  entries: Type.Array(MailOutboxEntrySchema),
})

export const MailSettingsResponseSchema = Type.Object({ settings: MailSettingsViewSchema })

export const MailTestResponseSchema = Type.Object({
  status: MailOutboxStatusSchema,
})
