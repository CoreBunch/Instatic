import { useUpdates } from './useUpdates'
import styles from './UpdatesBadge.module.css'

export function UpdatesBadge() {
  const { status, busy, error, store } = useUpdates()
  if (!store) return null
  if (status && !status.stale && !error && status.comparison !== 'unknown' && status.comparison !== 'update-available') return null
  const available = status && !status.stale && !error && status.comparison === 'update-available'
  const label = available ? `Instatic ${status.latest?.version} is available`
    : busy ? 'Checking Instatic release status' : 'Instatic release status needs attention'
  return <span className={styles.badge} data-available={available || undefined} role="img" aria-label={label}>{available ? '1' : busy ? '…' : '?'}</span>
}
