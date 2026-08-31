import { getActiveAdminLocale, translate } from '@admin/i18n'
/**
 * Pure formatting / labelling helpers used across the Users workspace.
 *
 * Display helpers use the active admin locale without changing CMS values.
 */
import type { CmsCurrentUser } from '@core/persistence'
import type { Tab } from '../types'

export function isOwnerUser(user: CmsCurrentUser): boolean {
  return user.role.slug === 'owner'
}

export function displayUserName(user: CmsCurrentUser): string {
  return user.displayName.trim() || user.email
}

export function statusLabel(status: CmsCurrentUser['status']): string {
  return status === 'active' ? 'Active' : 'Suspended'
}

export function formatDateTime(value: string | null): string {
  const locale = getActiveAdminLocale()
  return value ? new Date(value).toLocaleString(locale) : translate(locale, 'time.never')
}

export function formatCapabilitySummary(capabilities: string[]): string {
  const locale = getActiveAdminLocale()
  if (capabilities.length === 0) return translate(locale, 'users.noCapabilities')
  if (capabilities.length === 1) return translate(locale, 'users.oneCapability')
  return translate(locale, 'users.capabilities', { count: capabilities.length })
}

export function tabLabel(tab: Tab): string {
  return tab === 'users' ? 'Users' : tab === 'roles' ? 'Roles' : 'Audit'
}
