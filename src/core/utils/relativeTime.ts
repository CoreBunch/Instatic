/**
 * Terse relative time from an epoch-ms timestamp: "now", "5m", "3h", "2d",
 * then a locale date once older than a week. Shared by the conversation
 * history list and the message role markers.
 */
export function formatRelativeTime(epochMs: number): string {
  const ms = Date.now() - epochMs
  if (Number.isNaN(ms)) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(epochMs).toLocaleDateString()
}
