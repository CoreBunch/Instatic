import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Button } from '@ui/components/Button'
import { Widget } from '@ui/components/Widget'
import { useDomainStats } from '../hooks/useDashboardStats'
import styles from './widgets.module.css'

export function DomainWidget({ span, editing }: DashboardWidgetRendererProps) {
  const { data, loading, error, refresh } = useDomainStats()
  const publicOrigin = data?.publicOrigin

  return (
    <Widget
      widgetId="domain"
      title="Domain"
      icon={GlobeSolidIcon}
      tint="sky"
      span={span}
      editing={editing}
      loading={loading}
      action={error && !editing && (
        <Button variant="ghost" size="sm" onClick={refresh}>Retry</Button>
      )}
    >
      {error && <p className={styles.domainHint} role="status">Couldn’t load the public URL.</p>}
      {publicOrigin && (
        <>
          <p className={styles.domainName}>{publicOrigin.replace(/^https?:\/\//, '')}</p>
          <p className={styles.domainHint}>
            {publicOrigin.startsWith('https://') ? 'HTTPS configured' : 'Configured public URL'}
          </p>
        </>
      )}
      {publicOrigin === null && (
        <>
          <p className={styles.domainHint}>Public URL not configured.</p>
          <p className={styles.domainHint}>Set <code>PUBLIC_ORIGIN</code> on your server.</p>
        </>
      )}
    </Widget>
  )
}
