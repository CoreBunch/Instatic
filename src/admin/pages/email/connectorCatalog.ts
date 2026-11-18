/**
 * The kinds of mail connector the Email workspace can add, with the wording
 * the setup panel and lists use for each, and the SMTP presets that fill in
 * a well-known provider's server for the owner.
 */
import type { MailConnector, MailConnectorKind } from '@core/mail'

/** Which logo a mark shows. A kind or preset without one falls back to an icon. */
export type ConnectorLogo = 'resend' | 'mailgun' | 'brevo' | 'amazonses' | 'gmail' | 'microsoft' | 'sendgrid' | 'zoho'

export interface ConnectorSpec {
  kind: MailConnectorKind
  label: string
  shortLabel: string
  description: string
  /** What the one secret is called for this kind. */
  secretLabel: string
  /** The same, as it reads in the middle of a sentence. */
  secretName: string
  /** Where the owner finds that secret, shown under its field. */
  secretHint: string
  logo: ConnectorLogo | null
}

/**
 * One-key connectors first: they are the shortest way to working email and
 * they send over HTTPS, which hosts that block the SMTP ports still allow.
 */
export const CONNECTOR_SPECS: readonly ConnectorSpec[] = [
  {
    kind: 'resend',
    label: 'Resend',
    shortLabel: 'One API key',
    description: 'Send through Resend. All it needs is an API key and a sender address on a domain you verified there.',
    secretLabel: 'API key',
    secretName: 'API key',
    secretHint: 'From API Keys in the Resend dashboard. A key with sending access is enough.',
    logo: 'resend',
  },
  {
    kind: 'postmark',
    label: 'Postmark',
    shortLabel: 'One server token',
    description: 'Send through Postmark\'s transactional stream. All it needs is a server token and a sender you confirmed there.',
    secretLabel: 'Server API token',
    secretName: 'server API token',
    secretHint: 'From the API Tokens tab of your Postmark server.',
    logo: null,
  },
  {
    kind: 'mailgun',
    label: 'Mailgun',
    shortLabel: 'One API key and a domain',
    description: 'Send through Mailgun with a sending key and the domain you set up there.',
    secretLabel: 'API key',
    secretName: 'API key',
    secretHint: 'A sending key of the domain, or your account\'s private API key.',
    logo: 'mailgun',
  },
  {
    kind: 'brevo',
    label: 'Brevo',
    shortLabel: 'One API key',
    description: 'Send through Brevo\'s transactional email. All it needs is an API key and a sender you verified there.',
    secretLabel: 'API key',
    secretName: 'API key',
    secretHint: 'From SMTP & API, then API Keys, in your Brevo account.',
    logo: 'brevo',
  },
  {
    kind: 'ses',
    label: 'Amazon SES',
    shortLabel: 'AWS access key',
    description:
      'Send through Amazon Simple Email Service with an IAM access key that is allowed to call ses:SendEmail.',
    secretLabel: 'Secret access key',
    secretName: 'secret access key',
    secretHint: 'Shown once when the IAM access key is created.',
    logo: 'amazonses',
  },
  {
    kind: 'smtp',
    label: 'SMTP',
    shortLabel: 'Any mail server',
    description:
      'Send through any mail server or relay that speaks SMTP: Google Workspace, Microsoft 365, your web host and others.',
    secretLabel: 'Password',
    secretName: 'password',
    secretHint: 'Stored encrypted and never displayed again.',
    logo: null,
  },
]

export function getConnectorSpec(kind: MailConnectorKind): ConnectorSpec {
  return CONNECTOR_SPECS.find((spec) => spec.kind === kind) ?? CONNECTOR_SPECS[0]
}

// ─── SMTP presets ──────────────────────────────────────────────────────────

/** A well-known SMTP service: its server, and what its login is made of. */
export interface SmtpPreset {
  id: string
  label: string
  host: string
  port: number
  /** A fixed username, when the provider uses the same word for every account. */
  username?: string
  usernameHint: string
  passwordHint: string
  logo: ConnectorLogo | null
}

export const SMTP_PRESETS: readonly SmtpPreset[] = [
  {
    id: 'google',
    label: 'Google',
    host: 'smtp.gmail.com',
    port: 587,
    usernameHint: 'Your full Gmail or Google Workspace address.',
    passwordHint: 'An app password, not your Google password. It needs 2-Step Verification on the account.',
    logo: 'gmail',
  },
  {
    id: 'microsoft',
    label: 'Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    usernameHint: 'The full address of the mailbox that sends.',
    passwordHint: 'The mailbox password, or an app password. SMTP sign-in has to be allowed for the mailbox.',
    logo: 'microsoft',
  },
  {
    id: 'sendgrid',
    label: 'SendGrid',
    host: 'smtp.sendgrid.net',
    port: 587,
    username: 'apikey',
    usernameHint: 'Always the word "apikey".',
    passwordHint: 'A SendGrid API key with Mail Send access.',
    logo: 'sendgrid',
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    host: 'smtp.zoho.com',
    port: 587,
    usernameHint: 'Your full Zoho address. Accounts in the EU use smtp.zoho.eu as the host.',
    passwordHint: 'Your Zoho password, or an app password when two-factor sign-in is on.',
    logo: 'zoho',
  },
]

/** The preset a stored SMTP host belongs to, so a connected server shows its logo. */
export function smtpPresetForHost(host: string): SmtpPreset | null {
  const name = host.toLowerCase()
  return SMTP_PRESETS.find((preset) => preset.host === name) ?? null
}

export function connectorLogo(connector: Pick<MailConnector, 'kind' | 'config'>): ConnectorLogo | null {
  if (connector.kind === 'smtp') return smtpPresetForHost((connector.config as { host: string }).host)?.logo ?? null
  return getConnectorSpec(connector.kind).logo
}

/** Where a connector sends, in a few words. */
export function connectorEndpoint(connector: MailConnector): string {
  switch (connector.kind) {
    case 'smtp': return `${connector.config.host}:${connector.config.port}`
    case 'ses': return `SES, ${connector.config.region}`
    case 'mailgun': return `Mailgun, ${connector.config.domain}`
    default: return getConnectorSpec(connector.kind).label
  }
}

// ─── Local relays ──────────────────────────────────────────────────────────

const PRIVATE_IPV4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/**
 * Whether a typed SMTP host reads as a relay on this machine or network: a
 * name without a dot, a local-only suffix, or a private IPv4 address. It only
 * decides which hint the form shows; the server resolves the name and is the
 * one that refuses a private address.
 */
export function looksLikeLocalMailHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, '')
  if (!name) return false
  if (!name.includes('.')) return true
  if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true
  return /^[0-9.]+$/.test(name) && PRIVATE_IPV4.test(name)
}
