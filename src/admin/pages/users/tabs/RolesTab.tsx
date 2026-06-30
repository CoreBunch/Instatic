/**
 * Users → Roles tab.
 *
 * Lists every CMS role (system + custom) with capability count, type and an
 * action menu. System roles are immutable from the UI: only the View action
 * is available; Edit and Delete are hidden.
 *
 * Capability picking is grouped (`CAPABILITY_GROUPS`) with per-group
 * "All" / "Clear" shortcuts. The role form supports a `'view'` mode that
 * renders every input as `disabled` so admins can audit a role's
 * capabilities without entering edit mode.
 */
import { useEffect, useEffectEvent, useState, type FormEvent } from 'react'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { Button } from '@ui/components/Button'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import { Skeleton } from '@ui/components/Skeleton'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  createCmsRole,
  deleteCmsRole,
  updateCmsRole,
  type CmsRole,
} from '@core/persistence'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Badge } from '../components/Badge'
import { RowActionMenu } from '../components/RowActionMenu'
import { RoleDialog } from '../components/RoleDialog'
import { formatCapabilitySummary } from '../utils/format'
import {
  emptyRoleForm,
  type RoleDialogMode,
  type RoleFormState,
  type RowActionMenuItem,
} from '../types'
import type { UsersPageData } from '../hooks/useUsersPageData'
import styles from '../UsersPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface RolesTabProps {
  data: UsersPageData
  canManageRoles: boolean
}

async function saveRole(
  dialogMode: RoleDialogMode,
  editingRoleId: string | null,
  roleForm: RoleFormState,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  setRoles: (updater: (current: CmsRole[]) => CmsRole[]) => void,
  closeDialog: () => void,
  refresh: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    const role = dialogMode === 'edit' && editingRoleId
      ? await runStepUp(() => updateCmsRole(editingRoleId, roleForm))
      : await runStepUp(() => createCmsRole(roleForm))
    setRoles((current) => {
      const exists = current.some((candidate) => candidate.id === role.id)
      return exists
        ? current.map((candidate) => candidate.id === role.id ? role : candidate)
        : [...current, role]
    })
    closeDialog()
    void refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setError(getErrorMessage(err, 'Could not save role'))
  } finally {
    setBusy(false)
  }
}

async function deleteRole(
  roleId: string,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  setRoles: (updater: (current: CmsRole[]) => CmsRole[]) => void,
  refresh: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await runStepUp(() => deleteCmsRole(roleId))
    setRoles((current) => current.filter((candidate) => candidate.id !== roleId))
    void refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setError(getErrorMessage(err, 'Could not delete role'))
  } finally {
    setBusy(false)
  }
}

export function RolesTab({ data, canManageRoles }: RolesTabProps) {
  const { roles, setRoles, setError, refresh, error } = data
  const { runStepUp } = useStepUp()
  const [busy, setBusy] = useState(false)
  const [roleForm, setRoleForm] = useState<RoleFormState>(emptyRoleForm)
  const [dialogMode, setDialogMode] = useState<RoleDialogMode | null>(null)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)

  function closeDialog() {
    setDialogMode(null)
    setEditingRoleId(null)
    setRoleForm(emptyRoleForm)
  }

  function openCreate() {
    if (!canManageRoles) return
    setRoleForm(emptyRoleForm)
    setEditingRoleId(null)
    setDialogMode('create')
    setError(null)
  }

  // Auto-open the create-role dialog when the spotlight queued a
  // `users.newRole` action while the user was on a different workspace.
  // Guard on canManageRoles so we don't swallow the queued action on the
  // first render before capabilities are known. See UsersTab for why we
  // use queueMicrotask rather than setTimeout(0).
  // useEffectEvent reads latest openCreate without re-firing the effect on
  // every render. See UsersTab for the equivalent pattern + rationale.
  const consumeNewRolePending = useEffectEvent(() => {
    const pending = consumePendingAction('users.newRole')
    if (!pending) return
    queueMicrotask(() => openCreate())
  })

  useEffect(() => {
    if (!canManageRoles) return
    consumeNewRolePending()
  }, [canManageRoles])

  function openView(role: CmsRole) {
    if (!canManageRoles) return
    setEditingRoleId(role.id)
    setRoleForm({
      name: role.name,
      slug: role.slug,
      description: role.description,
      capabilities: role.capabilities,
    })
    setDialogMode('view')
    setError(null)
  }

  function openEdit(role: CmsRole) {
    // Owner is the only role whose capabilities are managed by the server
    // (synced from `CORE_CAPABILITIES` at boot). Every other role — including
    // the built-in `admin`, `client`, `member` — is editable by anyone with
    // `roles.manage`. System roles still can't be *deleted* (see `remove`).
    if (!canManageRoles || role.slug === 'owner') return
    setEditingRoleId(role.id)
    setRoleForm({
      name: role.name,
      slug: role.slug,
      description: role.description,
      capabilities: role.capabilities,
    })
    setDialogMode('edit')
    setError(null)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManageRoles || !dialogMode) return
    await saveRole(dialogMode, editingRoleId, roleForm, runStepUp, setRoles, closeDialog, refresh, setBusy, setError)
  }

  async function remove(role: CmsRole) {
    // System roles are never deletable — only their content (name, caps) can
    // be edited. Custom roles can be deleted when no users reference them
    // (server-side enforced).
    if (!canManageRoles || role.isSystem) return
    await deleteRole(role.id, runStepUp, setRoles, refresh, setBusy, setError)
  }


  return (
    <section className={styles.section} aria-labelledby="roles-list-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="roles-list-title">Roles</h2>
          <p>System roles are fixed. Custom roles can be edited.</p>
        </div>
        {canManageRoles && (
          <Button type="button" variant="primary" size="sm" onClick={openCreate}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Create Role</span>
          </Button>
        )}
      </div>
      {data.loading ? (
        <DataTable aria-label="Loading roles" density="compact" aria-busy="true">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Role</DataTableHeader>
              <DataTableHeader scope="col">Description</DataTableHeader>
              <DataTableHeader scope="col">Capabilities</DataTableHeader>
              <DataTableHeader scope="col">Type</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {Array.from({ length: 3 }, (_, i) => (
              <DataTableRow key={`skeleton-${i}`}>
                <DataTableCell><Skeleton width={120} height={13} /></DataTableCell>
                <DataTableCell><Skeleton width="80%" height={12} /></DataTableCell>
                <DataTableCell><Skeleton width={140} height={12} /></DataTableCell>
                <DataTableCell><Skeleton width={56} height={18} radius={999} /></DataTableCell>
                <DataTableCell className={styles.actionsCell}>
                  <Skeleton width={24} height={24} radius={6} />
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      ) : roles.length > 0 ? (
        <DataTable aria-label="Roles" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Role</DataTableHeader>
              <DataTableHeader scope="col">Description</DataTableHeader>
              <DataTableHeader scope="col">Capabilities</DataTableHeader>
              <DataTableHeader scope="col">Type</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {roles.map((role) => (
              <DataTableRow key={role.id} aria-label={`Role ${role.name}`}>
                <DataTableCell>
                  <strong className={styles.tableTitle}>{role.name}</strong>
                </DataTableCell>
                <DataTableCell>
                  <span className={styles.secondaryText}>{role.description || 'No description'}</span>
                </DataTableCell>
                <DataTableCell>
                  {role.capabilities.length > 0 ? (
                    <span className={styles.secondaryText}>{formatCapabilitySummary(role.capabilities)}</span>
                  ) : (
                    <Badge label="No admin capabilities" muted />
                  )}
                </DataTableCell>
                <DataTableCell>
                  <div className={styles.badges}>
                    <Badge label={role.isSystem ? 'System role' : 'Custom role'} muted={role.isSystem} />
                  </div>
                </DataTableCell>
                <DataTableCell className={styles.actionsCell}>
                  {canManageRoles && (
                    <RowActionMenu
                      triggerLabel={`Actions for ${role.name}`}
                      menuLabel={`Role actions for ${role.name}`}
                      disabled={busy}
                      items={[
                        {
                          label: 'View',
                          icon: <EyeSolidIcon size={12} aria-hidden="true" />,
                          onSelect: () => openView(role),
                        },
                        // Owner is locked entirely (capabilities are managed
                        // by the server). Other system roles can be edited
                        // but not deleted — they're part of the installation's
                        // expected role registry. Custom roles can be edited
                        // and deleted.
                        ...(role.slug !== 'owner'
                          ? [
                              {
                                label: 'Edit',
                                icon: <EditSolidIcon size={12} aria-hidden="true" />,
                                onSelect: () => openEdit(role),
                              },
                              ...(!role.isSystem
                                ? [{
                                    label: 'Delete',
                                    icon: <TrashSolidIcon size={12} aria-hidden="true" />,
                                    danger: true,
                                    onSelect: () => void remove(role),
                                  }] satisfies RowActionMenuItem[]
                                : []),
                            ] satisfies RowActionMenuItem[]
                          : []),
                      ]}
                    />
                  )}
                </DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      ) : (
        <p className={styles.emptyState}>No roles configured.</p>
      )}

      {canManageRoles && dialogMode && (
        <RoleDialog
          mode={dialogMode}
          form={roleForm}
          busy={busy}
          error={error}
          onChange={setRoleForm}
          onClose={closeDialog}
          onSubmit={handleSave}
        />
      )}
    </section>
  )
}
