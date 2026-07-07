/**
 * Activity widget — recent edits, publishes, plugin lifecycle, and
 * user/role changes pulled from `audit_events`. Reads from
 * `useRecentActivityStats()`, its own dashboard endpoint, so slower
 * audit projections do not block the other widgets from rendering.
 *
 * Login/logout events are intentionally excluded server-side — those
 * belong in Account → Sign-in history. The widget is about
 * *operational* changes to the site.
 */
import { DashboardSolidIcon } from 'pixel-art-icons/icons/dashboard-solid'
import { SettingsCogSolidIcon } from 'pixel-art-icons/icons/settings-cog-solid'
import type { ReactNode } from 'react'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { Widget } from '@ui/components/Widget'
import { cn } from '@ui/cn'
import {
  useRecentActivityStats,
  type DashboardActivityEntry,
} from '../hooks/useDashboardStats'
import styles from './widgets.module.css'

/**
 * Diameter of the actor avatar in the feed row. Picked to fit the
 * existing 22px-tall row chrome without changing line-height. The
 * `<UserAvatar>` primitive double-scales the requested size for the
 * Gravatar URL, so a 22px CSS avatar fetches a 44px image — crisp on
 * retina.
 */
const AVATAR_SIZE = 22

/**
 * Pick the verb that fronts each row body. The server has already
 * resolved the target into `targetCode` / `targetText`; this only
 * picks the right English verb for the action.
 *
 * Unknown / future actions fall through to a humanised version of
 * the action string itself ("plugin.foobar" → "plugin foobar") so a
 * newly-added audit event still renders something useful before the
 * widget is updated.
 */
function actionVerb(action: string): string {
  switch (action) {
    case 'data.row.create':
      return 'created'
    case 'data.row.update':
      return 'edited'
    case 'data.row.delete':
      return 'deleted'
    case 'data.row.publish':
      return 'published'
    case 'data.row.schedule':
      return 'scheduled'
    case 'data.row.schedule.cancel':
      return 'unscheduled'
    case 'data.row.status':
      return 'changed status of'
    case 'data.row.move':
      return 'moved'
    case 'data.author.assign':
      return 'reassigned author of'
    case 'data.table.create':
      return 'created collection'
    case 'data.table.update':
      return 'edited collection'
    case 'data.table.delete':
      return 'deleted collection'
    case 'publish':
      return 'published the site'
    case 'plugin.install':
      return 'installed plugin'
    case 'plugin.update':
      return 'updated plugin'
    case 'plugin.enable':
      return 'enabled plugin'
    case 'plugin.disable':
      return 'disabled plugin'
    case 'plugin.delete':
      return 'removed plugin'
    case 'plugin.pack.install':
      return 'installed plugin pack'
    case 'plugin.settings.update':
      return 'updated settings for'
    case 'user.create':
      return 'added user'
    case 'user.update':
      return 'updated user'
    case 'user.delete':
      return 'removed user'
    case 'user.suspend':
      return 'suspended user'
    case 'password.change':
      return 'changed password for'
    case 'role.create':
      return 'created role'
    case 'role.update':
      return 'updated role'
    case 'role.delete':
      return 'removed role'
    case 'role.assign':
      return 'assigned role'
    default:
      return action.replace(/[._]/g, ' ')
  }
}

function renderBody(entry: DashboardActivityEntry): ReactNode {
  const verb = actionVerb(entry.action)
  if (entry.targetCode) {
    return (
      <>
        {verb} <code>{entry.targetCode}</code>
      </>
    )
  }
  if (entry.targetText) {
    return (
      <>
        {verb} <em>{entry.targetText}</em>
      </>
    )
  }
  return verb
}

/**
 * Short relative-time label sized for the widget's narrow column.
 *
 *   < 1m         → "now"
 *   < 60m        → "<n>m"
 *   < 24h        → "<n>h"
 *   < 7d         → "<n>d"
 *   < 30d        → "yest." / "<n>d"
 *   anything else → coarse "MMM D" date
 *
 * Strictly past-only — `audit_events` are stamped at write time, so
 * a future timestamp would mean clock skew; in that case we just
 * render "now" rather than a misleading "in 3h".
 */
function formatRelative(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  const deltaMs = Date.now() - ts
  if (deltaMs < 0) return 'now'

  const min = deltaMs / 60_000
  if (min < 1) return 'now'
  if (min < 60) return `${Math.round(min)}m`

  const hr = min / 60
  if (hr < 24) return `${Math.round(hr)}h`

  const day = hr / 24
  if (day < 2) return 'yest.'
  if (day < 30) return `${Math.round(day)}d`

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ActivityWidget({ span, editing }: DashboardWidgetRendererProps) {
  const stats = useRecentActivityStats()
  const rows = stats?.rows ?? []
  const isLoading = stats === null
  const isEmpty = !isLoading && rows.length === 0

  return (
    <Widget
      widgetId="activity"
      title="Activity"
      icon={DashboardSolidIcon}
      tint="peach"
      span={span}
      editing={editing}
      loading={isLoading}
    >
      <div className={styles.feed}>
        {isEmpty && (
          <p className={cn(styles.feedTime, styles.feedEmpty)}>
            Nothing has happened yet — edits, publishes, and plugin changes
            will appear here.
          </p>
        )}
        {!isLoading && !isEmpty && rows.map((r) => (
          <div key={r.id} className={styles.feedRow}>
            {r.actor ? (
              <UserAvatar
                user={r.actor}
                size={AVATAR_SIZE}
                alt={`Avatar for ${r.actor.displayName || r.actor.email}`}
              />
            ) : (
              <span className={styles.feedSystemAvatar} title="System" aria-hidden="true">
                <SettingsCogSolidIcon size={12} />
              </span>
            )}
            <span className={styles.feedBody}>{renderBody(r)}</span>
            <span className={styles.feedTime}>{formatRelative(r.createdAt)}</span>
          </div>
        ))}
      </div>
    </Widget>
  )
}
