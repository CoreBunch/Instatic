/** Words for a member's status and activity, shared by the list and the detail panel. */
import type { MemberAdminStatus } from '@core/members'

export const STATUS_LABEL: Record<MemberAdminStatus, string> = {
  active: 'Active',
  pending: 'Pending',
  suspended: 'Suspended',
}

export const STATUS_TONE: Record<MemberAdminStatus, 'success' | 'warning' | 'danger'> = {
  active: 'success',
  pending: 'warning',
  suspended: 'danger',
}

const EVENT_LABEL: Record<string, string> = {
  signup: 'Signed up',
  verified: 'Confirmed their email address',
  login: 'Signed in',
  login_failed: 'Failed to sign in',
  logout: 'Signed out',
  app_connected: 'Signed an app in',
  app_disconnected: 'Disconnected an app',
  magic_link_requested: 'Asked for a sign-in link',
  password_reset_requested: 'Asked to reset their password',
  password_reset: 'Chose a new password',
  password_changed: 'Changed their password',
  email_change_requested: 'Asked to change their email address',
  email_changed: 'Changed their email address',
  profile_updated: 'Updated their profile',
  deleted: 'Account deleted',
  invited: 'Invited by an administrator',
  suspended: 'Suspended by an administrator',
  unsuspended: 'Restored by an administrator',
  signed_out_by_admin: 'Signed out everywhere by an administrator',
  app_disconnected_by_admin: 'An app was disconnected by an administrator',
  tag_granted: 'Given a tag by an administrator',
  tag_revoked: 'A tag was removed by an administrator',
}

/** A member event in plain words. An unknown kind is shown as written, never hidden. */
export function eventLabel(kind: string): string {
  return EVENT_LABEL[kind] ?? kind.replace(/_/g, ' ')
}

/** Where a tag came from: an administrator, or the plugin that granted it. */
export function tagSourceLabel(source: string): string {
  return source === 'admin' ? 'Added by an administrator' : `Granted by ${source}`
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}
