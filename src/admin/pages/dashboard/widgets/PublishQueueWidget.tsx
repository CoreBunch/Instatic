/**
 * Publish lineup widget — what's coming up next, what just shipped, and
 * what's still in drafts. Replaces the old static "Publish queue"
 * placeholder. Three slices, mixed into one chronological list:
 *
 *   • Scheduled rows  → "SCHEDULED" badge, "in 12m" / "in 3d" relative
 *   • Recently published → "PUBLISHED" badge, "5m ago" / "2d ago"
 *   • Drafts           → "DRAFT" badge, em-dash
 *
 * Data flows through `usePublishLineupStats()` — the server already
 * orders and limits the list so the widget just renders.
 */
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { cn } from '@ui/cn'
import {
  usePublishLineupStats,
  type DashboardPublishLineupRow,
} from '../hooks/useDashboardStats'
import styles from './widgets.module.css'

function badgeClass(status: DashboardPublishLineupRow['status']): string {
  if (status === 'scheduled') return styles.badgeQueued
  if (status === 'published') return styles.badgePublished
  return styles.badgeDraft
}

function badgeLabel(status: DashboardPublishLineupRow['status']): string {
  if (status === 'scheduled') return 'scheduled'
  if (status === 'published') return 'published'
  return 'draft'
}

/**
 * Format an ISO datetime as a short human-relative label.
 *
 *   future →  "in 12m" / "in 3h" / "in 2d"
 *   past   →  "5m ago" / "3h ago" / "yesterday" / "5d ago"
 *
 * Drafts pass null and get an em-dash. The thresholds are picked to
 * read well in the widget's narrow column — anything older than ~30
 * days falls through to a coarse date so the row stays compact.
 */
function formatRelative(iso: string | null): string {
  if (iso === null) return '—'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return '—'
  const deltaMs = ts - Date.now()
  const absMin = Math.abs(deltaMs) / 60_000
  const future = deltaMs > 0

  if (absMin < 1) return future ? 'soon' : 'just now'
  if (absMin < 60) {
    const n = Math.round(absMin)
    return future ? `in ${n}m` : `${n}m ago`
  }
  const absHr = absMin / 60
  if (absHr < 24) {
    const n = Math.round(absHr)
    return future ? `in ${n}h` : `${n}h ago`
  }
  const absDay = absHr / 24
  if (absDay < 30) {
    const n = Math.round(absDay)
    if (!future && n === 1) return 'yesterday'
    return future ? `in ${n}d` : `${n}d ago`
  }
  // Beyond a month — fall back to a date so the row doesn't read like
  // "in 73d" which is more noise than signal.
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function PublishQueueWidget({ span, editing }: DashboardWidgetRendererProps) {
  const stats = usePublishLineupStats()
  const rows = stats?.rows ?? []
  const isLoading = stats === null
  const isEmpty = !isLoading && rows.length === 0

  return (
    <Widget
      widgetId="publish"
      title="Publish lineup"
      icon={CloudUploadSolidIcon}
      tint="sky"
      span={span}
      editing={editing}
      loading={isLoading}
    >
      {isEmpty && (
        <p className={cn(styles.feedTime, styles.feedEmpty)}>
          Nothing in the lineup yet — schedule, publish, or draft a row to
          see it here.
        </p>
      )}
      {!isLoading && !isEmpty && (
        <ul className={styles.wlist}>
          {rows.map((r) => (
            <li key={r.id}>
              <span className={styles.wlistTitle}>
                <span className={styles.wlistPath}>{r.path}</span>
              </span>
              <span className={styles.wlistMeta}>
                <span className={`${styles.badge} ${badgeClass(r.status)}`}>{badgeLabel(r.status)}</span>
                <span>{formatRelative(r.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  )
}
