import { useEffect, useState, type MouseEvent } from 'react'
import { canAccessWorkspace, workspacePath } from '@admin/access'
import { Link, useNavigate } from '@admin/lib/routing'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { BRANCH_QUERY_PARAM } from '@admin/state/activeBranch'
import { switchBranch } from '@admin/state/branchStore'
import { MAIN_BRANCH_ID } from '@core/branches'
import type { DashboardWidgetRendererProps, PublishLineupRow } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { cn } from '@ui/cn'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { usePublishLineupStats } from '../hooks/useDashboardStats'
import styles from './widgets.module.css'

const BADGE_CLASS = {
  scheduled: styles.badgeQueued,
  overdue: styles.badgeOverdue,
  published: styles.badgePublished,
  draft: styles.badgeDraft,
}

function formatRelative(ts: number, now: number): string {
  const deltaMs = ts - now
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

function editorPath(row: PublishLineupRow, canOpenSite: boolean): string {
  const { id, tableSlug, tableKind } = row
  const workspace = tableKind === 'postType' ? 'content'
    : canOpenSite && (tableKind === 'page' || tableKind === 'component') ? 'site'
      : 'data'
  return workspacePath(workspace) + '?' + new URLSearchParams({ table: tableSlug, row: id })
}

export function PublishLineupWidget({ span, editing }: DashboardWidgetRendererProps) {
  const { data: stats, refresh } = usePublishLineupStats()
  const rows = stats?.rows
  const user = useAuthenticatedAdminUser()
  const canOpenSite = canAccessWorkspace(user, 'site')
  const navigate = useNavigate()
  const [now, setNow] = useState(Date.now)
  const nextScheduled = rows?.find((row) => row.status === 'scheduled' && row.at && Date.parse(row.at) > now)

  useEffect(() => {
    if (!rows?.length) return
    const untilDue = nextScheduled?.at ? Date.parse(nextScheduled.at) - Date.now() : Infinity
    const timer = setTimeout(() => {
      setNow(Date.now())
      if (!editing && rows.some((row) => row.status === 'scheduled')) refresh()
    }, Math.max(0, Math.min(60_000, untilDue)))
    return () => clearTimeout(timer)
  }, [rows, nextScheduled, now, editing, refresh])

  function openEditor(event: MouseEvent<HTMLAnchorElement>, path: string) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    switchBranch(MAIN_BRANCH_ID)
    navigate(path)
  }

  return (
    <Widget
      widgetId="publish"
      title="Publish lineup"
      icon={CloudUploadSolidIcon}
      tint="sky"
      span={span}
      editing={editing}
      loading={!rows}
    >
      {rows?.length === 0 && (
        <p className={cn(styles.feedTime, styles.feedEmpty)}>No scheduled, published, or draft entries yet.</p>
      )}
      {rows && rows.length > 0 && (
        <ul className={styles.lineupList}>
          {rows.map((row) => {
            const at = Date.parse(row.at ?? '')
            const badge = row.status === 'scheduled' && at <= now ? 'overdue' : row.status
            const path = editorPath(row, canOpenSite)
            const label = row.path ?? (row.slug || 'Untitled entry')
            const details = (
              <>
                <span className={styles.lineupName}>
                  <span className={styles.lineupPath} title={label}>{label}</span>
                  {row.path === null && <span className={styles.lineupNoPath}>No public path</span>}
                </span>
                <span className={styles.wlistMeta}>
                  <span className={cn(styles.badge, BADGE_CLASS[badge])}>{badge}</span>
                  {row.at && Number.isFinite(at) && (
                    <time dateTime={row.at} title={new Date(at).toLocaleString()}>
                      {formatRelative(at, now)}
                    </time>
                  )}
                </span>
              </>
            )
            return (
              <li key={row.id}>
                {editing ? (
                  <span className={styles.lineupRow}>{details}</span>
                ) : (
                  <Link
                    className={styles.lineupRow}
                    to={path + '&' + new URLSearchParams({ [BRANCH_QUERY_PARAM]: MAIN_BRANCH_ID })}
                    onClick={(event) => openEditor(event, path)}
                  >
                    {details}
                    <ChevronRightIcon size={12} aria-hidden="true" />
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Widget>
  )
}
