/**
 * Site status widget — rows of (site / build / backup / plugins) with a
 * status dot per row.
 */
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { Link } from '@admin/lib/routing'
import { useUpdates } from '@admin/updates/useUpdates'
import styles from './widgets.module.css'

interface Row { label: string; value: string; tone: 'green' | 'amber' }

const ROWS: readonly Row[] = [
  { label: 'Site', value: 'Live', tone: 'green' },
  { label: 'Build', value: '3m ago', tone: 'green' },
  { label: 'Backup', value: '2h ago', tone: 'green' },
]

export function StatusWidget({ span, editing }: DashboardWidgetRendererProps) {
  const { status, busy, error, store } = useUpdates()
  const available = status && !status.stale && !error && status.comparison === 'update-available'
  const current = status && !status.stale && !error && status.comparison === 'current'
  const updateLabel = busy && !status ? 'Checking…' : available ? `${status.latest?.version} available`
    : current ? `${status.build.version} · up to date` : status?.comparison === 'ahead' && !status.stale && !error ? 'Ahead of stable release' : 'Status unavailable'
  return (
    <Widget
      widgetId="status"
      title="Status"
      icon={ZapSolidIcon}
      tint="mint"
      span={span}
      editing={editing}
    >
      <div className={styles.statusGrid}>
        {store && <div className={styles.statusRow}>
          <span className={styles.statusLabel}>
            <span className={`${styles.dot} ${current ? styles.dotGreen : styles.dotAmber}`} />
            Instatic
          </span>
          <Link to="/admin/updates" className={styles.wlistMeta}>{updateLabel}</Link>
        </div>}
        {ROWS.map((r) => (
          <div key={r.label} className={styles.statusRow}>
            <span className={styles.statusLabel}>
              <span className={`${styles.dot} ${r.tone === 'green' ? styles.dotGreen : styles.dotAmber}`} />
              {r.label}
            </span>
            <span className={styles.wlistMeta}>{r.value}</span>
          </div>
        ))}
      </div>
    </Widget>
  )
}
