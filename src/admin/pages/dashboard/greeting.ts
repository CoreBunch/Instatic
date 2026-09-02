import { getActiveAdminLocale, translate } from '@admin/i18n'

export function formatDashboardGreeting(displayName: string | null | undefined, now = new Date()): string {
  const hour = now.getHours()
  const period = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const name = displayName?.trim().split(/\s+/)[0]
  const locale = getActiveAdminLocale()
  return name
    ? translate(locale, `dashboard.${period}Named`, { name })
    : translate(locale, `dashboard.${period}`)
}
