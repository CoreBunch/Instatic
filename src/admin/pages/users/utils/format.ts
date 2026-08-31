/**
 * Pure formatting / labelling helpers used across the Users workspace.
 *
 * Everything here is pure: no React, no API calls, no DOM. The functions
 * convert raw CMS values into the strings the UI shows.
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

export function formatCapabilitySummary(capabilities: string[]): string {
  if (capabilities.length === 0) return 'No admin capabilities'
  const capabilityLabel = capabilities.length === 1 ? 'capability' : 'capabilities'
  return `${capabilities.length} ${capabilityLabel}`
}

export function tabLabel(tab: Tab): string {
  return tab === 'users' ? 'Users' : tab === 'roles' ? 'Roles' : 'Audit'
}
