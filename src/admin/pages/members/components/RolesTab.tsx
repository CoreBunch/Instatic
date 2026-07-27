/**
 * Members → Roles tab.
 *
 * Lists every visitor role (system `member`/`admin` + any custom roles) with
 * a capability summary, a system/custom badge, and inline edit / delete
 * actions. Mirrors `pages/users/tabs/RolesTab.tsx` in structure but is
 * simpler:
 *   - visitor roles carry only name + free-form capability strings (no slug,
 *     no description), so there is no `CapabilityPicker`;
 *   - there is no Owner-lock — system roles are editable (name + caps) but
 *     never deletable (server-side enforced);
 *   - actions are inline ghost icon buttons (matching the members
 *     `VisitorsTable`), not an overflow `ContextMenu`.
 *
 * Every mutation (create / update / delete) optimistically updates the local
 * role list via `setRoles`, then reconciles with `refresh()`. 409 failures
 * ("name in use" / "cannot delete assigned role") surface in the dialog.
 */
import { useState, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import { Dialog } from '@ui/components/Dialog'
import { TagPill } from '@ui/components/TagPill'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  createVisitorRole,
  deleteVisitorRole,
  updateVisitorRole,
  type VisitorRole,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { MembersData } from '../hooks/useMembersData'
import { emptyVisitorRoleForm, type VisitorRoleDialogMode, type VisitorRoleFormState } from '../types'
import { RoleDialog } from './RoleDialog'
import styles from '../MembersPage.module.css'

interface RolesTabProps {
  data: MembersData
}

/** Inline summary of a role's capability list (e.g. "2 capabilities"). */
function capabilitySummary(capabilities: string[]): string {
  if (capabilities.length === 0) return 'No capabilities'
  return `${capabilities.length} ${capabilities.length === 1 ? 'capability' : 'capabilities'}`
}

export function RolesTab({ data }: RolesTabProps) {
  const { roles, setRoles, setError, refresh } = data
  const [busy, setBusy] = useState(false)
  const [dialogMode, setDialogMode] = useState<VisitorRoleDialogMode | null>(null)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [roleForm, setRoleForm] = useState<VisitorRoleFormState>(emptyVisitorRoleForm)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<VisitorRole | null>(null)

  function closeDialog() {
    setDialogMode(null)
    setEditingRoleId(null)
    setRoleForm(emptyVisitorRoleForm)
    setDialogError(null)
  }

  function openCreate() {
    setRoleForm(emptyVisitorRoleForm)
    setEditingRoleId(null)
    setDialogError(null)
    setDialogMode('create')
  }

  function openEdit(role: VisitorRole) {
    setEditingRoleId(role.id)
    setRoleForm({ name: role.name, capabilities: [...role.capabilities] })
    setDialogError(null)
    setDialogMode('edit')
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dialogMode) return
    setBusy(true)
    setDialogError(null)
    try {
      const role =
        dialogMode === 'edit' && editingRoleId
          ? await updateVisitorRole(editingRoleId, roleForm)
          : await createVisitorRole(roleForm)
      setRoles((current) => {
        const exists = current.some((candidate) => candidate.id === role.id)
        return exists
          ? current.map((candidate) => (candidate.id === role.id ? role : candidate))
          : [...current, role]
      })
      closeDialog()
      void refresh()
    } catch (err) {
      setDialogError(getErrorMessage(err, 'Could not save role'))
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelete() {
    const target = pendingDelete
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await deleteVisitorRole(target.id)
      setRoles((current) => current.filter((candidate) => candidate.id !== target.id))
      setPendingDelete(null)
      void refresh()
    } catch (err) {
      // 409 (system role / still assigned to visitors) and any other failure
      // both surface through the shared page error channel; the dialog stays
      // open so the admin can retry or cancel after reading the message.
      setError(getErrorMessage(err, 'Could not delete role'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby="visitor-roles-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="visitor-roles-title">Visitor roles</h2>
          <p>System roles can be edited but not deleted. Custom roles can be deleted when unassigned.</p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={openCreate} disabled={busy}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Create Role</span>
        </Button>
      </div>

      {roles.length > 0 ? (
        <DataTable aria-label="Visitor roles" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Role</DataTableHeader>
              <DataTableHeader scope="col">Capabilities</DataTableHeader>
              <DataTableHeader scope="col">Type</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {roles.map((role) => {
              const label = role.name
              return (
                <DataTableRow key={role.id} aria-label={`Visitor role ${label}`}>
                  <DataTableCell>
                    <div className={styles.identity}>
                      <strong>{label}</strong>
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    {role.capabilities.length > 0 ? (
                      <div className={styles.capChips}>
                        {role.capabilities.map((capability) => (
                          <TagPill key={capability} label={capability} size="xs" />
                        ))}
                      </div>
                    ) : (
                      <span className={styles.secondaryText}>{capabilitySummary(role.capabilities)}</span>
                    )}
                  </DataTableCell>
                  <DataTableCell>
                    <TagPill label={role.isSystem ? 'System' : 'Custom'} muted={role.isSystem} size="xs" />
                  </DataTableCell>
                  <DataTableCell className={styles.actionsCell}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Edit role ${label}`}
                      disabled={busy}
                      onClick={() => openEdit(role)}
                    >
                      <EditSolidIcon size={12} aria-hidden="true" />
                    </Button>
                    {!role.isSystem && (
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        type="button"
                        aria-label={`Delete role ${label}`}
                        disabled={busy}
                        onClick={() => setPendingDelete(role)}
                      >
                        <TrashSolidIcon size={12} aria-hidden="true" />
                      </Button>
                    )}
                  </DataTableCell>
                </DataTableRow>
              )
            })}
          </DataTableBody>
        </DataTable>
      ) : (
        <p className={styles.emptyState}>No visitor roles configured.</p>
      )}

      {dialogMode && (
        <RoleDialog
          mode={dialogMode}
          form={roleForm}
          busy={busy}
          error={dialogError}
          onChange={setRoleForm}
          onClose={closeDialog}
          onSubmit={handleSave}
        />
      )}

      {pendingDelete && (
        <Dialog
          open
          onClose={busy ? () => {} : () => setPendingDelete(null)}
          tone="danger"
          eyebrow="Delete visitor role"
          title={pendingDelete.name}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy}
              >
                {busy ? 'Deleting…' : 'Delete role'}
              </Button>
            </>
          }
        >
          <p>
            Delete the visitor role <strong>{pendingDelete.name}</strong>? This
            only succeeds when no visitors are currently assigned to it.
          </p>
        </Dialog>
      )}
    </section>
  )
}
