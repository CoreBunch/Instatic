import { formatRelativeTime } from '@core/utils/relativeTime'

/** "updated just now" / "updated 3h ago" / "updated 12/03/2026". */
export function describeUpdated(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp)
  if (Number.isNaN(ms) || ms <= 0) return ''
  const relative = formatRelativeTime(ms)
  if (relative === 'now') return 'updated just now'
  if (/^\d+[mhd]$/.test(relative)) return `updated ${relative} ago`
  return `updated ${relative}`
}
