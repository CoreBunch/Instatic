import { formatRelativeTimeAgo } from '@core/utils/relativeTime'

/** "updated just now" / "updated 3h ago" / "updated 12/03/2026". */
export function describeUpdated(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp)
  if (Number.isNaN(ms) || ms <= 0) return ''
  return `updated ${formatRelativeTimeAgo(ms)}`
}
