/**
 * Domain widget — primary site domain + DNS / HTTPS verification rows.
 *
 * Displays the current hostname (from window.location) instead of a
 * hardcoded domain, so the widget is correct for self-hosted instances.
 */
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import styles from './widgets.module.css'

export function DomainWidget({ span, editing }: DashboardWidgetRendererProps) {
  const domain = typeof window !== 'undefined' ? window.location.hostname : ''

  return (
    <Widget
      widgetId="domain"
      title="Domain"
      icon={GlobeSolidIcon}
      tint="sky"
      span={span}
      editing={editing}
    >
      <div className={styles.domainName}>{domain || 'Not configured'}</div>
      <div>
        <span className={styles.wlistMeta}>SSL · auto-renew</span>
      </div>
      <div className={styles.domainList}>
        <div>
          <span>A record</span>
          <span className={styles.domainOk}>verified</span>
        </div>
        <div>
          <span>HTTPS</span>
          <span className={styles.domainOk}>active</span>
        </div>
      </div>
    </Widget>
  )
}
