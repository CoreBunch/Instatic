import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import type { MailConnectorKind } from '@core/mail'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'

const ICON_SIZE = { sm: 14, md: 18, lg: 22 } as const

/** The identity chip of a connector kind, in the workspace's service-mark style. */
export function ConnectorMark({ kind, size = 'md' }: { kind: MailConnectorKind; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = kind === 'ses' ? CloudUploadSolidIcon : SendSolidIcon
  return (
    <span className={ws.providerMark} data-size={size} aria-hidden="true">
      <Icon size={ICON_SIZE[size]} />
    </span>
  )
}
