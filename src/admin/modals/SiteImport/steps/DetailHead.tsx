/**
 * DetailHead — the header of a Review-step detail pane: title, one-line
 * description, and the "N of M · All · None" bulk cluster.
 */
import styles from './AnalyzeStep.module.css'

interface DetailHeadProps {
  title: string
  sub: string
  count: number
  total: number
  warn?: boolean
  hideBulk?: boolean
  onAll?: () => void
  onNone?: () => void
}

export function DetailHead({ title, sub, count, total, warn, hideBulk, onAll, onNone }: DetailHeadProps) {
  return (
    <div className={styles.detHead} data-warn={warn ? 'true' : undefined}>
      <div className={styles.detHeadText}>
        <h3 className={styles.detHeadTitle}>{title}</h3>
        <span className={styles.sectionSub}>{sub}</span>
      </div>
      {!hideBulk && (
        <div className={styles.detHeadBulk}>
          <span className={styles.detHeadCount}>
            {count} of {total}
          </span>
          <button type="button" className={styles.link} onClick={onAll}>
            All
          </button>
          <span className={styles.bulkSep}>·</span>
          <button type="button" className={styles.link} onClick={onNone}>
            None
          </button>
        </div>
      )}
    </div>
  )
}
