/**
 * Members widget — total registered-visitor count + a daily registration
 * histogram for the last 28 days. Data comes from `useMembersStats()`
 * (server-side aggregated from `visitor_users.created_at`, with the
 * visitor-auth toggle states so the sub-line reads auth/registration at
 * a glance).
 *
 * Membership-fork first-party widget — see `widgets/index.ts` for the
 * deliberate-divergence note (upstream removed first-party visitor
 * widgets; this membership fork re-adds one).
 *
 * Skeleton: `loading={stats === null}` and the Widget primitive handles
 * the rest. Degrades gracefully with zero visitors (total 0, empty bars).
 */
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import { Bars, StatValue } from '@ui/components/charts'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { useMembersStats } from '../hooks/useDashboardStats'

// Last 6 days of the histogram are highlighted as the "current week".
const ACCENT_INDEXES = [22, 23, 24, 25, 26, 27]

/**
 * One-line auth/registration status for the StatValue sub-line. Keeps the
 * three meaningful combinations readable rather than cramming two booleans
 * into a label: when auth is off the registration toggle is irrelevant, so
 * we don't show it.
 */
function authStatusLine(stats: { authEnabled: boolean; registrationOpen: boolean }): string {
  if (!stats.authEnabled) return 'Auth off'
  return stats.registrationOpen ? 'Registration open' : 'Registration closed'
}

export function MembersWidget({ span, editing }: DashboardWidgetRendererProps) {
  const stats = useMembersStats()
  return (
    <Widget
      widgetId="members"
      title="Members"
      icon={UsersSolidIcon}
      tint="mint"
      span={span}
      editing={editing}
      loading={stats === null}
    >
      {stats && (
        <>
          <StatValue
            value={stats.total.toLocaleString()}
            sub={
              <span>
                Registered · {authStatusLine(stats)}
              </span>
            }
          />
          <Bars data={stats.daily28} accentIndexes={ACCENT_INDEXES} />
        </>
      )}
    </Widget>
  )
}
