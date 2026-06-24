/**
 * AI usage widget — "this month" rollup from `/admin/api/ai/audit`.
 *
 * Headline number: total USD cost. Caption: chat count + top scope. A
 * Sparkline below tracks daily cost for the current month so the operator
 * can spot a runaway day at a glance.
 *
 * The widget calls the same audit endpoint the `/admin/ai` Audit tab uses;
 * it just narrows `since` to the start of the calendar month. If the user
 * lacks `ai.audit.read` (e.g. a Client-role admin who can edit content
 * but not see site-wide AI spend) the endpoint returns 403 and the widget
 * falls back to a "no permission" empty state — same pattern as the
 * existing widgets that gracefully no-op on missing capability.
 */
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { ZapSolidIcon } from 'pixel-art-icons/icons/zap-solid'
import type { DashboardWidgetRendererProps } from '@core/dashboard'
import { Sparkline, StatValue } from '@ui/components/charts'
import { Widget } from '@ui/components/Widget'
import {
  listAiAudit,
  type AiAuditResponse,
} from '@admin/ai/api'
import { ApiError } from '@core/http'
import styles from './widgets.module.css'

function startOfMonthIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '< $0.01'
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function topScope(data: AiAuditResponse): string | null {
  const sorted = [...data.byScope].sort((a, b) => b.costUsd - a.costUsd)
  return sorted[0]?.scope ?? null
}

interface UsageState {
  data: AiAuditResponse | null
  /** True when the caller lacked the audit capability — we render an empty state. */
  forbidden: boolean
}

/**
 * Standalone fetcher hook (rather than re-using the dashboard's shared
 * `useDashboardEndpoint`) because the AI audit lives under
 * `/admin/api/ai/*` — a different namespace from `/admin/api/cms/dashboard/*`
 * — and uses a `since` query param the dashboard helper doesn't carry.
 *
 * The loader maps a 403 (caller lacks `ai.audit.read`) to the `forbidden`
 * state so the widget hides its content instead of blowing up the dashboard;
 * any other failure is swallowed by `useAsyncResource` and the widget keeps
 * its skeleton (state stays null).
 */
function useAiUsageThisMonth(): UsageState {
  const { data } = useAsyncResource<UsageState>(
    async () => {
      try {
        return { data: await listAiAudit(startOfMonthIso()), forbidden: false }
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          return { data: null, forbidden: true }
        }
        throw err
      }
    },
    [],
    { swallowErrors: true },
  )
  return data ?? { data: null, forbidden: false }
}

export function AiUsageWidget({ span, editing }: DashboardWidgetRendererProps) {
  const { data, forbidden } = useAiUsageThisMonth()
  const isLoading = data === null && !forbidden

  return (
    <Widget
      widgetId="ai-usage"
      title="AI usage"
      icon={ZapSolidIcon}
      tint="lilac"
      span={span}
      editing={editing}
      loading={isLoading}
    >
      {forbidden && (
        <p className={styles.feedTime}>
          You don't have permission to see site-wide AI usage.
        </p>
      )}
      {data && (
        <>
          <StatValue
            value={formatCost(data.totals.costUsd)}
            sub={
              <span>
                {data.totals.chatCount} chats this month
                {topScope(data) ? ` · top: ${topScope(data)}` : ''}
              </span>
            }
          />
          {data.byDay.length >= 2 && (
            <Sparkline
              data={data.byDay.map((d) => d.costUsd)}
              tint="var(--accent-2)"
              ariaLabel="AI cost per day this month"
            />
          )}
        </>
      )}
    </Widget>
  )
}
