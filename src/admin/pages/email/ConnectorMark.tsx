import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { cn } from '@ui/cn'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import type { ConnectorLogo } from './connectorCatalog'
import styles from './ConnectorMark.module.css'

const ICON_SIZE = { sm: 14, md: 18, lg: 22 } as const

const LOGO_CLASS: Record<ConnectorLogo, string> = {
  resend: styles.logoResend,
  mailgun: styles.logoMailgun,
  brevo: styles.logoBrevo,
  amazonses: styles.logoAmazonses,
  gmail: styles.logoGmail,
  microsoft: styles.logoMicrosoft,
  sendgrid: styles.logoSendgrid,
  zoho: styles.logoZoho,
}

/**
 * The identity chip of a mail service, in the workspace's service-mark
 * style: the provider's logo when there is one, a send icon otherwise.
 */
export function ConnectorMark({ logo, size = 'md' }: { logo: ConnectorLogo | null; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={cn(ws.providerMark, styles.mark)} data-logo={logo ?? 'none'} data-size={size} aria-hidden="true">
      {logo ? <span className={cn(ws.providerLogo, LOGO_CLASS[logo])} /> : <SendSolidIcon size={ICON_SIZE[size]} />}
    </span>
  )
}
