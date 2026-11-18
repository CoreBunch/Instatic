const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 })
const shortDate = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** Compact count, e.g. 15193062 → "15.2M", 4300 → "4.3K", 120300 → "120K". */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return compactNumber.format(value)
}

/** Relative age of an ISO timestamp: "today", "3d ago", "2mo ago", "4y ago". */
export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'unknown'
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return 'unknown'
  const days = Math.floor((now - time) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return shortDate.format(date)
}
