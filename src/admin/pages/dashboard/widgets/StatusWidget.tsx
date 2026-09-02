/**
 * Site status widget — rows of (site / build / backup / plugins) with a
 * status dot per row.
 */
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import styles from './widgets.module.css'

interface Row { label: string; valueLabel: string; tone: 'green' | 'amber' }

const ROWS: readonly Row[] = [
  { label: 'Site', valueLabel: 'Live', tone: 'green' },
  { label: 'Build', valueLabel: '3m ago', tone: 'green' },
  { label: 'Backup', valueLabel: '2h ago', tone: 'green' },
  { label: 'Plugins', valueLabel: '1 update', tone: 'amber' },
]

export function StatusWidget({ span, editing }: DashboardWidgetRendererProps) {
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
        {ROWS.map((r) => (
          <div key={r.label} className={styles.statusRow}>
            <span className={styles.statusLabel}>
              <span className={`${styles.dot} ${r.tone === 'green' ? styles.dotGreen : styles.dotAmber}`} />
              {r.label}
            </span>
            <span className={styles.wlistMeta}>{r.valueLabel}</span>
          </div>
        ))}
      </div>
    </Widget>
  )
}
