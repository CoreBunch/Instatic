/** Role options shared by the Users workspace. Each directory loads its own page. */
import { useEffect, useState } from 'react'
import {
  listCmsRoles,
  type CmsRole,
} from '@core/persistence'
import type { WorkspaceLoadState } from '@admin/lib/workspaceLoadState'
import { emptyUserForm } from '../types'
import { getErrorMessage } from '@core/utils/errorMessage'

export interface UsersPageData extends WorkspaceLoadState {
  roles: CmsRole[]
  /**
   * The first role id that admins can assign to a user (i.e. excludes the
   * Owner role). Used to seed the create-user dialog so it never opens
   * with a stale or impossible role selection.
   */
  defaultAssignableRoleId: string
  setRoles: (updater: (current: CmsRole[]) => CmsRole[]) => void
  setError: (value: string | null) => void
  refresh: () => void
}

export function useUsersPageData(canReadRoles: boolean): UsersPageData {
  const [roles, setRoles] = useState<CmsRole[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const next = canReadRoles ? await listCmsRoles() : []
        if (!cancelled) setRoles(next)
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err, 'Could not load roles'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [canReadRoles, revision])

  const defaultAssignableRoleId =
    roles.find((role) => role.id !== 'owner')?.id ?? emptyUserForm.roleId

  return {
    roles,
    loading,
    error,
    defaultAssignableRoleId,
    setRoles,
    setError,
    refresh: () => setRevision((value) => value + 1),
  }
}
