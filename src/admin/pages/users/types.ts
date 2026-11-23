/**
 * Shared types for the Users workspace.
 *
 * These types are shared across the page shell, the per-tab components, the
 * dialogs and the helper utilities. Keep them dialect-naive — no React
 * imports, no DOM types, no API client imports.
 */
import type { ReactNode } from 'react'
import type { CmsCurrentUser } from '@core/persistence'

export type Tab = 'users' | 'members' | 'roles' | 'audit'
export type UserDialogMode = 'create' | 'edit' | 'reset'
export type RoleDialogMode = 'create' | 'edit' | 'view'

export interface UserFormState {
  email: string
  displayName: string
  password: string
  roleId: string
  status: CmsCurrentUser['status']
}

export interface RoleFormState {
  name: string
  slug: string
  description: string
  capabilities: string[]
}

export interface RowActionMenuItem {
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

export const emptyUserForm: UserFormState = {
  email: '',
  displayName: '',
  password: '',
  roleId: 'viewer',
  status: 'active',
}

export const emptyRoleForm: RoleFormState = {
  name: '',
  slug: '',
  description: '',
  capabilities: [],
}
