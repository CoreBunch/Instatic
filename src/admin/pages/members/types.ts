/**
 * Shared types for the Members workspace.
 *
 * Dialect-naive — no React, no DOM, no API client imports. Kept here so the
 * page shell, the Roles tab and the role dialog share one source of truth
 * for tab + form-state shapes (mirrors `pages/users/types.ts`).
 */

/** Top-level tab on `/admin/members`. */
export type MembersTab = 'visitors' | 'groups' | 'roles'

/** Role dialog mode — visitor roles are always editable, so there is no
 *  read-only `'view'` mode (unlike the admin `RoleDialogMode`). */
export type VisitorRoleDialogMode = 'create' | 'edit'

/** Editable shape of a visitor role (capabilities are free-form strings). */
export interface VisitorRoleFormState {
  name: string
  capabilities: string[]
}

export const emptyVisitorRoleForm: VisitorRoleFormState = {
  name: '',
  capabilities: [],
}

/** Group dialog mode — visitor groups are always editable, so there is no
 *  read-only `'view'` mode. */
export type VisitorGroupDialogMode = 'create' | 'edit'

/**
 * Editable shape of a visitor group (Phase 3 — D13/D15). `landingPath` defaults
 * to `/` on the server when blank.
 */
export interface VisitorGroupFormState {
  name: string
  landingPath: string
  description: string
}

export const emptyVisitorGroupForm: VisitorGroupFormState = {
  name: '',
  landingPath: '/',
  description: '',
}
