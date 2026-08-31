import { getActiveAdminLocale } from "@admin/i18n"
/**
 * Posts widget — total post count + daily-publish histogram for the
 * last 28 days. Data comes from `usePostsStats()` (server-side
 * aggregated from `data_rows.published_at` across every
 * `kind: 'postType'` table).
 *
 * Skeleton: `loading={stats === null}` and the Widget primitive
 * handles the rest.
 */
import { PenSquareSolidIcon } from 'pixel-art-icons/icons/pen-square-solid'
import { Bars, StatValue } from '@ui/components/charts'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Widget } from '@ui/components/Widget'
import { usePostsStats } from '../hooks/useDashboardStats'

// Last 6 days of the histogram are highlighted as the "current week".
const ACCENT_INDEXES = [22, 23, 24, 25, 26, 27]

export function PostsWidget({ span, editing }: DashboardWidgetRendererProps) {
  const stats = usePostsStats()
  return (
    <Widget
      widgetId="posts"
      title="Posts"
      icon={PenSquareSolidIcon}
      tint="peach"
      span={span}
      editing={editing}
      loading={stats === null}
    >
      {stats && (
        <>
          <StatValue
            value={stats.total.toLocaleString(getActiveAdminLocale())}
            sub={(
              stats.categories === 0
                ? <span>Total · no categories yet</span>
                : <span>Total · {stats.categories} categor{stats.categories === 1 ? 'y' : 'ies'}</span>
            )}
          />
          <Bars data={stats.daily28} accentIndexes={ACCENT_INDEXES} />
        </>
      )}
    </Widget>
  )
}
