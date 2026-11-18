/**
 * The kinds of mail connector the Email workspace can add, with the wording
 * the setup panel and lists use for each.
 */
import type { MailConnector, MailConnectorKind } from '@core/mail'

export interface ConnectorSpec {
  kind: MailConnectorKind
  label: string
  shortLabel: string
  description: string
  /** What the one secret is called for this kind. */
  secretLabel: string
}

export const CONNECTOR_SPECS: readonly ConnectorSpec[] = [
  {
    kind: 'smtp',
    label: 'SMTP',
    shortLabel: 'Any mail server',
    description:
      'Send through any mail server or relay that speaks SMTP: your host, Google Workspace, Mailgun, Postmark and others.',
    secretLabel: 'Password',
  },
  {
    kind: 'ses',
    label: 'Amazon SES',
    shortLabel: 'AWS Simple Email Service',
    description:
      'Send through Amazon Simple Email Service with an IAM access key that is allowed to call ses:SendEmail.',
    secretLabel: 'Secret access key',
  },
]

export function getConnectorSpec(kind: MailConnectorKind): ConnectorSpec {
  return CONNECTOR_SPECS.find((spec) => spec.kind === kind) ?? CONNECTOR_SPECS[0]
}

/** Where a connector sends, in a few words. */
export function connectorEndpoint(connector: MailConnector): string {
  return connector.kind === 'smtp'
    ? `${connector.config.host}:${connector.config.port}`
    : `SES, ${connector.config.region}`
}
