/**
 * Members → Groups tab (Phase 3 — D13/D14/D15).
 *
 * Lists every visitor member-group (system groups + any custom groups) with its
 * slug, landing path, member count, and description, plus inline edit / delete
 * actions. Mirrors `RolesTab.tsx` in structure. Groups are content-segmentation
 * segments (page access — D14, login-redirect landing — D15), orthogonal to
 * roles (capabilities — D13).
 *
 * Member counts are not carried on the group row, so the tab fetches each
 * group's member list in parallel on load and on group-list change. The number
 * of groups is small (a handful to a dozen), so the N-request fan-out is
 * bounded and avoids a bespoke bulk-count endpoint.
 *
 * Every mutation (create / update / delete) optimistically updates the local
 * group list via `setGroups`, then reconciles with `refresh()`. 409 failures
 * ("name in use") surface in the dialog.
 */
import { useEffect, useState, type FormEvent } from 'react'
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
import { Skeleton } from '@ui/components/Skeleton'
import { TagPill } from '@ui/components/TagPill'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  createVisitorGroup,
  deleteVisitorGroup,
  listGroupMembers,
  updateVisitorGroup,
  type VisitorGroup,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { MembersData } from '../hooks/useMembersData'
import { emptyVisitorGroupForm, type VisitorGroupDialogMode, type VisitorGroupFormState } from '../types'
import { GroupDialog } from './GroupDialog'
import styles from '../MembersPage.module.css'

interface GroupsTabProps {
  data: MembersData
}

export function GroupsTab({ data }: GroupsTabProps) {
  const { groups, setGroups, setError, refresh } = data
  const [busy, setBusy] = useState(false)
  const [dialogMode, setDialogMode] = useState<VisitorGroupDialogMode | null>(null)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [groupForm, setGroupForm] = useState<VisitorGroupFormState>(emptyVisitorGroupForm)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<VisitorGroup | null>(null)
  // groupId → member count. Fetched in parallel whenever the group list
  // changes; a missing key means "loading" (renders the count skeleton).
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    // No synchronous setState in the body: when there are no groups the table
    // renders its empty state (no rows read the count map), so there is
    // nothing to reset. Every setState lives inside the async `.then`. Stale
    // counts for a removed group linger in the map but are never read.
    if (groups.length === 0) return
    let cancelled = false
    Promise.all(groups.map((group) => listGroupMembers(group.id).then(({ members }) => [group.id, members.length] as const)))
      .then((entries) => {
        if (cancelled) return
        const next: Record<string, number> = {}
        for (const [id, count] of entries) next[id] = count
        setMemberCounts(next)
      })
      .catch(() => {
        /* best-effort — counts stay as the loading skeleton */
      })
    return () => {
      cancelled = true
    }
  }, [groups])

  function closeDialog() {
    setDialogMode(null)
    setEditingGroupId(null)
    setGroupForm(emptyVisitorGroupForm)
    setDialogError(null)
  }

  function openCreate() {
    setGroupForm(emptyVisitorGroupForm)
    setEditingGroupId(null)
    setDialogError(null)
    setDialogMode('create')
  }

  function openEdit(group: VisitorGroup) {
    setEditingGroupId(group.id)
    setGroupForm({
      name: group.name,
      landingPath: group.landingPath || '/',
      description: group.description || '',
    })
    setDialogError(null)
    setDialogMode('edit')
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dialogMode) return
    setBusy(true)
    setDialogError(null)
    try {
      const group =
        dialogMode === 'edit' && editingGroupId
          ? await updateVisitorGroup(editingGroupId, {
              name: groupForm.name,
              landingPath: groupForm.landingPath,
              description: groupForm.description,
            })
          : await createVisitorGroup({
              name: groupForm.name,
              landingPath: groupForm.landingPath,
              description: groupForm.description,
            })
      setGroups((current) => {
        const exists = current.some((candidate) => candidate.id === group.id)
        return exists
          ? current.map((candidate) => (candidate.id === group.id ? group : candidate))
          : [...current, group]
      })
      closeDialog()
      void refresh()
    } catch (err) {
      setDialogError(getErrorMessage(err, 'Could not save group'))
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
      await deleteVisitorGroup(target.id)
      setGroups((current) => current.filter((candidate) => candidate.id !== target.id))
      setPendingDelete(null)
      void refresh()
    } catch (err) {
      setError(getErrorMessage(err, 'Could not delete group'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby="visitor-groups-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="visitor-groups-title">Member groups</h2>
          <p>Groups segment visitors for page access and login redirects. A visitor can belong to several.</p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={openCreate} disabled={busy}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Create Group</span>
        </Button>
      </div>

      {groups.length > 0 ? (
        <DataTable aria-label="Member groups" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Group</DataTableHeader>
              <DataTableHeader scope="col">Landing path</DataTableHeader>
              <DataTableHeader scope="col">Members</DataTableHeader>
              <DataTableHeader scope="col">Type</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {groups.map((group) => {
              const label = group.name
              const count = memberCounts[group.id]
              return (
                <DataTableRow key={group.id} aria-label={`Member group ${label}`}>
                  <DataTableCell>
                    <div className={styles.identity}>
                      <strong>{label}</strong>
                      <span className={styles.secondaryText}>
                        {group.slug}
                        {group.description ? ` · ${group.description}` : ''}
                      </span>
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    <span className={styles.secondaryText}>{group.landingPath || '/'}</span>
                  </DataTableCell>
                  <DataTableCell>
                    {count === undefined ? (
                      <Skeleton width={28} height={12} />
                    ) : (
                      <span className={styles.secondaryText}>
                        {count} {count === 1 ? 'member' : 'members'}
                      </span>
                    )}
                  </DataTableCell>
                  <DataTableCell>
                    <TagPill label={group.isSystem ? 'System' : 'Custom'} muted={group.isSystem} size="xs" />
                  </DataTableCell>
                  <DataTableCell className={styles.actionsCell}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Edit group ${label}`}
                      disabled={busy}
                      onClick={() => openEdit(group)}
                    >
                      <EditSolidIcon size={12} aria-hidden="true" />
                    </Button>
                    {!group.isSystem && (
                      <Button
                        variant="ghost"
                        size="xs"
                        iconOnly
                        type="button"
                        aria-label={`Delete group ${label}`}
                        disabled={busy}
                        onClick={() => setPendingDelete(group)}
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
        <p className={styles.emptyState}>No member groups yet.</p>
      )}

      {dialogMode && (
        <GroupDialog
          mode={dialogMode}
          form={groupForm}
          busy={busy}
          error={dialogError}
          onChange={setGroupForm}
          onClose={closeDialog}
          onSubmit={handleSave}
        />
      )}

      {pendingDelete && (
        <Dialog
          open
          onClose={busy ? () => {} : () => setPendingDelete(null)}
          tone="danger"
          eyebrow="Delete member group"
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
                {busy ? 'Deleting…' : 'Delete group'}
              </Button>
            </>
          }
        >
          <p>
            Delete the member group <strong>{pendingDelete.name}</strong>? Every
            visitor is removed from the group, and any page access or login
            redirect relying on it stops applying.
          </p>
        </Dialog>
      )}
    </section>
  )
}
