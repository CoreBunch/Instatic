/**
 * Wire shapes for outgoing mail, shared by the server (`server/mail/`,
 * `server/handlers/cms/mail.ts`) and the admin Email workspace.
 *
 * Secrets (an SMTP password, an AWS secret key) only ever travel browser →
 * server. No response shape here carries one: a connector reports
 * `hasSecret` instead.
 */
import { Type, type Static } from '@sinclair/typebox'

/** Header-safe single line: no CR or LF, so a value can never add a header. */
const SINGLE_LINE = '^[^\\r\\n]*$'

/** Deliberately loose: one `@`, no spaces or line breaks. The provider is the real judge. */
export const MAIL_ADDRESS_PATTERN = '^[^\\s@]+@[^\\s@]+$'

export const MailAddressSchema = Type.String({
  minLength: 3,
  maxLength: 320,
  pattern: MAIL_ADDRESS_PATTERN,
})

// ─── Connectors ────────────────────────────────────────────────────────────

/**
 * `smtp` and `ses` take several values. The rest are "one-key" connectors:
 * a provider's own HTTP API, set up with a single API key, sent over HTTPS
 * (so they also work where a host blocks the SMTP ports).
 */
export const MAIL_CONNECTOR_KINDS = ['smtp', 'ses', 'resend', 'postmark', 'mailgun', 'brevo'] as const
export const MailConnectorKindSchema = Type.Union(MAIL_CONNECTOR_KINDS.map((kind) => Type.Literal(kind)))
export type MailConnectorKind = (typeof MAIL_CONNECTOR_KINDS)[number]

export const SmtpConnectorConfigSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253, pattern: '^[a-zA-Z0-9.-]+$' }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    username: Type.String({ maxLength: 320, pattern: SINGLE_LINE }),
  },
  { additionalProperties: false },
)
export type SmtpConnectorConfig = Static<typeof SmtpConnectorConfigSchema>

export const SesConnectorConfigSchema = Type.Object(
  {
    /** An AWS region id such as `eu-central-1`; it becomes part of the API host. */
    region: Type.String({ pattern: '^[a-z]{2}(-[a-z]+)+-\\d$', maxLength: 30 }),
    accessKeyId: Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Z0-9]+$' }),
  },
  { additionalProperties: false },
)
export type SesConnectorConfig = Static<typeof SesConnectorConfigSchema>

/** A provider that needs nothing but its API key. */
export const KeyOnlyConnectorConfigSchema = Type.Object({}, { additionalProperties: false })
export type KeyOnlyConnectorConfig = Static<typeof KeyOnlyConnectorConfigSchema>

export const MailgunConnectorConfigSchema = Type.Object(
  {
    /** The sending domain set up in Mailgun; it becomes part of the API path. */
    domain: Type.String({ minLength: 3, maxLength: 253, pattern: '^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$' }),
    /** Mailgun keeps EU accounts on a separate API host. */
    region: Type.Union([Type.Literal('us'), Type.Literal('eu')]),
  },
  { additionalProperties: false },
)
export type MailgunConnectorConfig = Static<typeof MailgunConnectorConfigSchema>

/** The config schema of each connector kind: the one place a kind's stored shape is named. */
export const MAIL_CONNECTOR_CONFIG_SCHEMAS = {
  smtp: SmtpConnectorConfigSchema,
  ses: SesConnectorConfigSchema,
  resend: KeyOnlyConnectorConfigSchema,
  postmark: KeyOnlyConnectorConfigSchema,
  mailgun: MailgunConnectorConfigSchema,
  brevo: KeyOnlyConnectorConfigSchema,
} as const

const ConnectorLabelSchema = Type.String({ minLength: 1, maxLength: 80, pattern: SINGLE_LINE })
/** An SMTP password or an AWS secret access key. Empty is allowed for an open local relay. */
const ConnectorSecretSchema = Type.String({ maxLength: 1024 })
/** An API key goes into a request header, so it is one line and never empty. */
const ApiKeySchema = Type.String({ minLength: 1, maxLength: 1024, pattern: SINGLE_LINE })

export const MailConnectorInputSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('smtp'),
      label: ConnectorLabelSchema,
      config: SmtpConnectorConfigSchema,
      secret: ConnectorSecretSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ses'),
      label: ConnectorLabelSchema,
      config: SesConnectorConfigSchema,
      secret: Type.String({ minLength: 1, maxLength: 1024 }),
    },
    { additionalProperties: false },
  ),
  ...(['resend', 'postmark', 'brevo'] as const).map((kind) =>
    Type.Object(
      {
        kind: Type.Literal(kind),
        label: ConnectorLabelSchema,
        config: KeyOnlyConnectorConfigSchema,
        secret: ApiKeySchema,
      },
      { additionalProperties: false },
    ),
  ),
  Type.Object(
    {
      kind: Type.Literal('mailgun'),
      label: ConnectorLabelSchema,
      config: MailgunConnectorConfigSchema,
      secret: ApiKeySchema,
    },
    { additionalProperties: false },
  ),
])
export type MailConnectorInput = Static<typeof MailConnectorInputSchema>

export const MailConnectorSecretInputSchema = Type.Object(
  { secret: ConnectorSecretSchema },
  { additionalProperties: false },
)

const ConnectorCommon = {
  id: Type.String(),
  label: Type.String(),
  hasSecret: Type.Boolean(),
  /** The stored secret was encrypted with a different server secret key. */
  secretNeedsReentry: Type.Boolean(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
  /** What went wrong the last time this connector was used, if it failed. */
  lastError: Type.Union([Type.String(), Type.Null()]),
  /** True while queued email is held because this connector refuses the account (see `lastError`). */
  deliveryPaused: Type.Boolean(),
  createdAt: Type.String(),
}

export const MailConnectorSchema = Type.Union([
  Type.Object({ ...ConnectorCommon, kind: Type.Literal('smtp'), config: SmtpConnectorConfigSchema }),
  Type.Object({ ...ConnectorCommon, kind: Type.Literal('ses'), config: SesConnectorConfigSchema }),
  Type.Object({ ...ConnectorCommon, kind: Type.Literal('resend'), config: KeyOnlyConnectorConfigSchema }),
  Type.Object({ ...ConnectorCommon, kind: Type.Literal('postmark'), config: KeyOnlyConnectorConfigSchema }),
  Type.Object({ ...ConnectorCommon, kind: Type.Literal('brevo'), config: KeyOnlyConnectorConfigSchema }),
  Type.Object({ ...ConnectorCommon, kind: Type.Literal('mailgun'), config: MailgunConnectorConfigSchema }),
])
export type MailConnector = Static<typeof MailConnectorSchema>

// ─── Defaults ──────────────────────────────────────────────────────────────

export const MailDefaultsSchema = Type.Object(
  {
    /** The connector every email goes through, or null when none is chosen. */
    defaultConnectorId: Type.Union([Type.String(), Type.Null()]),
    fromAddress: Type.Union([MailAddressSchema, Type.Literal('')]),
    fromName: Type.String({ maxLength: 120, pattern: SINGLE_LINE }),
    replyTo: Type.Union([MailAddressSchema, Type.Literal('')]),
  },
  { additionalProperties: false },
)
export type MailDefaults = Static<typeof MailDefaultsSchema>

/**
 * How the server delivers mail right now.
 *  - `send`: a default connector and a sender address are set.
 *  - `capture`: they are not, and this is a development server; mail is
 *    written to the activity log (with its body) instead of leaving the machine.
 *  - `off`: they are not, on a production server; sending fails.
 */
export const MailDeliveryModeSchema = Type.Union([
  Type.Literal('send'),
  Type.Literal('capture'),
  Type.Literal('off'),
])
export type MailDeliveryMode = Static<typeof MailDeliveryModeSchema>

export const MailOverviewSchema = Type.Object({
  mode: MailDeliveryModeSchema,
  connectors: Type.Array(MailConnectorSchema),
  defaults: MailDefaultsSchema,
  /**
   * The configured public origin links in emails are built from, or null when
   * none is configured (links cannot be built safely from the Host header).
   */
  publicOrigin: Type.Union([Type.String(), Type.Null()]),
  /** The operator allowed private-network SMTP relays (`MAIL_ALLOW_PRIVATE_HOSTS`). */
  privateHostsAllowed: Type.Boolean(),
})
export type MailOverview = Static<typeof MailOverviewSchema>

export const MailOverviewResponseSchema = Type.Object({ overview: MailOverviewSchema })
export const MailConnectorResponseSchema = Type.Object({ connector: MailConnectorSchema })

// ─── Templates ─────────────────────────────────────────────────────────────

export const MailTemplateVariableSchema = Type.Object({
  /** The token name, written `{name}` in a subject or body. */
  name: Type.String(),
  label: Type.String(),
  /** The value the preview shows: the site's real one for `site.*`, a realistic made-up one otherwise. */
  sample: Type.String(),
  /**
   * What the value is. A `link` is an address: it is put into an email only
   * where it stands alone or is the whole address of a link. `text` (the
   * default) may sit anywhere in a sentence.
   */
  kind: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('link')])),
})
export type MailTemplateVariable = Static<typeof MailTemplateVariableSchema>

export const MailTemplateSchema = Type.Object({
  key: Type.String(),
  label: Type.String(),
  description: Type.String(),
  group: Type.String(),
  variables: Type.Array(MailTemplateVariableSchema),
  subject: Type.String(),
  body: Type.String(),
  /** False while the template still has its built-in wording. */
  customised: Type.Boolean(),
  /**
   * Set when the owner's wording cannot be sent as written (it puts a link
   * where it does not stand alone): the built-in wording is sent instead
   * until the edit is corrected.
   */
  wordingProblem: Type.Union([Type.String(), Type.Null()]),
})
export type MailTemplate = Static<typeof MailTemplateSchema>

export const MailTemplateInputSchema = Type.Object(
  {
    subject: Type.String({ minLength: 1, maxLength: 200, pattern: SINGLE_LINE }),
    body: Type.String({ minLength: 1, maxLength: 20000 }),
  },
  { additionalProperties: false },
)
export type MailTemplateInput = Static<typeof MailTemplateInputSchema>

export const MailTemplatesResponseSchema = Type.Object({ templates: Type.Array(MailTemplateSchema) })
export const MailTemplateResponseSchema = Type.Object({ template: MailTemplateSchema })

// ─── Sending and activity ──────────────────────────────────────────────────

export const MailTestInputSchema = Type.Object(
  { to: MailAddressSchema },
  { additionalProperties: false },
)

/**
 * `queued` is an email that has not left yet: waiting for its first attempt,
 * or for the next one after a temporary failure (`attempts` > 0).
 */
export const MailActivityStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('sent'),
  Type.Literal('failed'),
  Type.Literal('captured'),
])
export type MailActivityStatus = Static<typeof MailActivityStatusSchema>

export const MailTestResponseSchema = Type.Object({ status: MailActivityStatusSchema })

export const MailActivityEntrySchema = Type.Object({
  id: Type.String(),
  /** The template key, or `test` for a connector test. */
  kind: Type.String(),
  /** The template's name, for people. */
  kindLabel: Type.String(),
  /** True when `kind` is a template in the catalogue, so the admin can open it. */
  template: Type.Boolean(),
  to: Type.String(),
  subject: Type.String(),
  status: MailActivityStatusSchema,
  connectorLabel: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  /** The id the provider gave the message, to find it in the provider's own logs. */
  providerMessageId: Type.Union([Type.String(), Type.Null()]),
  /** How long the hand-over to the provider took. */
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  /** The plugin that asked for the email, by name. Null for the site's own email. */
  sentBy: Type.Union([Type.String(), Type.Null()]),
  /** Delivery attempts made so far. */
  attempts: Type.Integer(),
  /** When a queued email is tried next. Null once it has left or been given up on. */
  nextAttemptAt: Type.Union([Type.String(), Type.Null()]),
  /** Present only for mail captured on a development server. */
  body: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})
export type MailActivityEntry = Static<typeof MailActivityEntrySchema>

const MailActivityCountsSchema = Type.Object({
  queued: Type.Integer(),
  sent: Type.Integer(),
  failed: Type.Integer(),
  captured: Type.Integer(),
})
export type MailActivityCounts = Static<typeof MailActivityCountsSchema>

export const MailActivityPeriodSchema = Type.Union([
  Type.Literal('24h'),
  Type.Literal('7d'),
  Type.Literal('30d'),
  Type.Literal('all'),
])
export type MailActivityPeriod = Static<typeof MailActivityPeriodSchema>

const MailActivityFacetSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  count: Type.Integer(),
})

export const MailActivityResponseSchema = Type.Object({
  /** One page of the emails that match every filter, newest first. */
  entries: Type.Array(MailActivityEntrySchema),
  /** Pass as `before` to read the next page. Null on the last one. */
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  /** How many emails match every filter. */
  matching: Type.Integer(),
  /** Counts over the period, before the status, template, connector and search filters. */
  totals: MailActivityCountsSchema,
  /** The period one bucket at a time, oldest first: hours for `24h`, days otherwise. */
  buckets: Type.Array(
    Type.Object({
      start: Type.String(),
      queued: Type.Integer(),
      sent: Type.Integer(),
      failed: Type.Integer(),
      captured: Type.Integer(),
    }),
  ),
  /** The newest failure in the period, whatever the filters. */
  lastFailure: Type.Union([Type.Object({ at: Type.String(), error: Type.String() }), Type.Null()]),
  /**
   * Why the newest waiting email has not left, when an attempt has failed:
   * a temporary failure, or a connector that needs fixing. Null when every
   * waiting email is simply waiting its turn.
   */
  waitingError: Type.Union([Type.String(), Type.Null()]),
  /** The templates and connectors seen in the period, for the filter menus. */
  kinds: Type.Array(MailActivityFacetSchema),
  connectors: Type.Array(MailActivityFacetSchema),
  /** The log keeps this many emails per sender (the site, and each plugin); older ones are dropped. */
  retention: Type.Integer(),
})
export type MailActivityResponse = Static<typeof MailActivityResponseSchema>
