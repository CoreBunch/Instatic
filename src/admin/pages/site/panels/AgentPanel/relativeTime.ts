import { getActiveAdminLocale, translate } from '@admin/i18n'
/**
 * Terse relative time from an epoch-ms timestamp: "now", "5m", "3h", "2d",
 * then a locale date once older than a week. Shared by the conversation
 * history list and the message role markers.
 */
export function formatRelativeTime(epochMs: number): string {
  const locale = getActiveAdminLocale()
  const ms = Date.now() - epochMs
  if (Number.isNaN(ms)) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return translate(locale, 'time.now')
  if (minutes < 60) return translate(locale, 'time.minutesShort', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return translate(locale, 'time.hoursShort', { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return translate(locale, 'time.daysShort', { count: days })
  return new Date(epochMs).toLocaleDateString(locale)
}
