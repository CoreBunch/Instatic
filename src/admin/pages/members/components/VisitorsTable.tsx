/**
 * VisitorsTable — the visitor-account table on the Members workspace.
 *
 * Mirrors the structure of `pages/users/tabs/UsersTab.tsx`: a search box at
 * the top, a `DataTable` of rows with inline role/status controls, and a
 * row action to delete. Every mutation (role change, status toggle, delete)
 * optimistically updates the local list via `setUsers`, then reconciles
 * with the server response (or reverts on error).
 *
 * Unlike the Users tab there is no step-up gate — visitor mutations go
 * straight through. There is also no owner row, so every row is fully
 * actionable.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
// Copy icon for the Member ID affordance (the cross-system / CRM identifier).
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import { Dialog } from '@ui/components/Dialog'
import { SearchBar } from '@ui/components/SearchBar'
import { Select } from '@ui/components/Select'
import { Skeleton } from '@ui/components/Skeleton'
import { TagPill } from '@ui/components/TagPill'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { PowerOffIcon } from 'pixel-art-icons/icons/power-off'
import { PowerIcon } from 'pixel-art-icons/icons/power'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'
import {
  deleteVisitorUser,
  getVisitorGroups,
  updateVisitorUser,
  type AdminVisitorUser,
  type VisitorMembership,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { MembersData } from '../hooks/useMembersData'
import { AssignGroupsDialog } from './AssignGroupsDialog'
import { EditProfileDialog } from './EditProfileDialog'
import styles from '../MembersPage.module.css'
// Edit icon for the per-visitor profile value editor.
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'

interface VisitorsTableProps {
  data: MembersData
}

/** A visitor is "locked" only while the lockout window is still open. */
function isLocked(user: AdminVisitorUser): boolean {
  return Boolean(user.lockedUntil) && Date.parse(user.lockedUntil as string) > Date.now()
}

function formatDate(iso: string): string {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return iso
  return new Date(parsed).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Role-picker options for a row. The saved `roleId` is always selectable —
 * if it no longer matches a known role (deleted / stale), a placeholder
 * option is prepended so the dropdown shows what's persisted instead of
 * silently snapping to the first row.
 */
function roleOptionsFor(
  roles: MembersData['roles'],
  currentRoleId: string,
): { value: string; label: string }[] {
  const options = roles.map((role) => ({ value: role.id, label: role.name }))
  if (currentRoleId && !options.some((option) => option.value === currentRoleId)) {
    return [{ value: currentRoleId, label: `${currentRoleId} (unknown role)` }, ...options]
  }
  return options
}

/**
 * The Groups cell — renders a visitor's membership chips (the primary group
 * highlighted) and a ghost icon button that opens the AssignGroupsDialog.
 * `userMemberships` is `undefined` while that visitor's membership is still
 * loading (renders a skeleton). An empty list renders an "Assign" affordance
 * so an ungrouped visitor still has a discoverable entry point.
 */
function GroupsCell({
  userMemberships,
  onAssign,
}: {
  userMemberships: VisitorMembership[] | undefined
  onAssign: () => void
}) {
  if (userMemberships === undefined) {
    return <Skeleton width={120} height={18} radius={999} />
  }
  if (userMemberships.length === 0) {
    return (
      <Button
        variant="ghost"
        size="xs"
        type="button"
        onClick={onAssign}
        aria-label="Assign groups"
      >
        <UsersSolidIcon size={12} aria-hidden="true" />
        <span>Assign</span>
      </Button>
    )
  }
  // Sort so the primary group leads, then alphabetical — the primary chip
  // is rendered active (accent tint) to flag the login-landing group (D15).
  const ordered = [...userMemberships].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return a.group.name.localeCompare(b.group.name)
  })
  return (
    <Button
      variant="ghost"
      size="xs"
      type="button"
      onClick={onAssign}
      aria-label={`Manage groups: ${ordered.map((m) => m.group.name).join(', ') || 'none'}`}
    >
      <span className={styles.groupsCell}>
        {ordered.map((membership) => (
          <TagPill
            key={membership.group.id}
            label={membership.isPrimary ? `${membership.group.name} · primary` : membership.group.name}
            active={membership.isPrimary}
            muted={!membership.isPrimary}
            size="xs"
          />
        ))}
      </span>
    </Button>
  )
}

export function VisitorsTable({ data }: VisitorsTableProps) {
  const {
    users,
    roles,
    groups,
    total,
    loading,
    search,
    setSearch,
    setUsers,
    setError,
  } = data

  const [busyId, setBusyId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AdminVisitorUser | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Which visitor's Member ID was just copied — shows a transient checkmark.
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Per-visitor group memberships, for the Groups column. The admin visitor
  // shape doesn't carry groups, so the table loads each loaded visitor's
  // membership in parallel (the list is paginated to a bounded page size).
  const [memberships, setMemberships] = useState<Record<string, VisitorMembership[]>>({})
  const [assignTarget, setAssignTarget] = useState<AdminVisitorUser | null>(null)
  // Per-visitor-data framework: the visitor whose profile field values are
  // being edited in the EditProfileDialog.
  const [profileTarget, setProfileTarget] = useState<AdminVisitorUser | null>(null)

  // Re-load memberships whenever the loaded visitor set changes. Failures are
  // best-effort (a failed read leaves the row's Groups cell as a loading
  // skeleton) so one unreachable visitor doesn't block the whole table. No
  // synchronous setState in the body: when the visitor set is empty the table
  // renders its empty state (no rows read the membership map), so there is
  // nothing to reset; every setState lives inside the async `.then`.
  useEffect(() => {
    if (users.length === 0) return
    let cancelled = false
    Promise.all(
      users.map((user) =>
        getVisitorGroups(user.id).then(({ groups: ms }) => [user.id, ms] as const),
      ),
    )
      .then((entries) => {
        if (cancelled) return
        const next: Record<string, VisitorMembership[]> = {}
        for (const [id, ms] of entries) next[id] = ms
        setMemberships(next)
      })
      .catch(() => {
        /* best-effort — cells keep the loading skeleton */
      })
    return () => {
      cancelled = true
    }
  }, [users])

  function handleAssignSaved(userId: string, result: { groupIds: string[]; primaryGroupId: string | null }) {
    // Optimistically mirror the saved membership into the local map using the
    // full group rows (so chips show names immediately, without a refetch).
    const resolved = groups
      .filter((group) => result.groupIds.includes(group.id))
      .map((group) => ({ group, isPrimary: group.id === result.primaryGroupId }))
    setMemberships((current) => ({ ...current, [userId]: resolved }))
    setAssignTarget(null)
  }

  function handleProfileSaved(userId: string, profileFields: Record<string, unknown>) {
    // Optimistically mirror the saved values into the local user list so the
    // table reflects them immediately without a refetch.
    setUsers((current) =>
      current.map((candidate) =>
        candidate.id === userId ? { ...candidate, profileFields } : candidate,
      ),
    )
    setProfileTarget(null)
  }

  function displayName(user: AdminVisitorUser): string {
    return user.displayName?.trim() || user.email
  }

  /** Copy a visitor's stable Member ID (the cross-system identifier) to clipboard. */
  async function copyMemberId(user: AdminVisitorUser) {
    try {
      await navigator.clipboard.writeText(user.id)
      setCopiedId(user.id)
      window.setTimeout(() => setCopiedId((current) => (current === user.id ? null : current)), 1500)
    } catch (err) {
      console.error('[members] clipboard write failed:', err)
    }
  }

  async function changeRole(user: AdminVisitorUser, newRoleId: string) {
    if (newRoleId === user.roleId || busyId) return
    const previous = user
    // Optimistic: reflect the new role immediately. roleName is best-effort
    // (resolved from the local role list) and reconciled by the server
    // response below.
    const optimisticRoleName = roles.find((role) => role.id === newRoleId)?.name ?? newRoleId
    setUsers((current) =>
      current.map((candidate) =>
        candidate.id === user.id
          ? { ...candidate, roleId: newRoleId, roleName: optimisticRoleName }
          : candidate,
      ),
    )
    setBusyId(user.id)
    try {
      const updated = await updateVisitorUser(user.id, { roleId: newRoleId })
      setUsers((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)))
    } catch (err) {
      setError(getErrorMessage(err, 'Could not change role'))
      setUsers((current) => current.map((candidate) => (candidate.id === user.id ? previous : candidate)))
    } finally {
      setBusyId(null)
    }
  }

  async function toggleStatus(user: AdminVisitorUser) {
    if (busyId) return
    const next = user.status === 'active' ? 'suspended' : 'active'
    const previous = user
    setUsers((current) =>
      current.map((candidate) => (candidate.id === user.id ? { ...candidate, status: next } : candidate)),
    )
    setBusyId(user.id)
    try {
      const updated = await updateVisitorUser(user.id, { status: next })
      setUsers((current) => current.map((candidate) => (candidate.id === updated.id ? updated : candidate)))
    } catch (err) {
      setError(getErrorMessage(err, 'Could not update status'))
      setUsers((current) => current.map((candidate) => (candidate.id === user.id ? previous : candidate)))
    } finally {
      setBusyId(null)
    }
  }

  async function confirmDelete() {
    const target = pendingDelete
    if (!target) return
    setDeleting(true)
    try {
      await deleteVisitorUser(target.id)
      setUsers((current) => current.filter((candidate) => candidate.id !== target.id))
      setPendingDelete(null)
    } catch (err) {
      setError(getErrorMessage(err, 'Could not delete visitor'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby="visitors-title">
      <div className={styles.toolbar}>
        <div>
          <h2 id="visitors-title">Visitors</h2>
          {/* Suppress the count while loading — it reads like an empty install
              otherwise. */}
          <p>{loading ? '\u00A0' : `${total} registered visitor${total === 1 ? '' : 's'}.`}</p>
        </div>
        <SearchBar
          className={styles.search}
          value={search}
          onValueChange={setSearch}
          placeholder="Search by email or name"
          aria-label="Search visitors"
        />
      </div>

      {loading ? (
        <DataTable aria-label="Loading visitors" density="compact" aria-busy="true">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Visitor</DataTableHeader>
              <DataTableHeader scope="col">Role</DataTableHeader>
              <DataTableHeader scope="col">Groups</DataTableHeader>
              <DataTableHeader scope="col">Status</DataTableHeader>
              <DataTableHeader scope="col">Created</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {Array.from({ length: 3 }, (_, index) => (
              <DataTableRow key={`skeleton-${index}`}>
                <DataTableCell>
                  <div className={styles.identity}>
                    <Skeleton width={160} height={13} />
                    <Skeleton width={200} height={11} />
                  </div>
                </DataTableCell>
                <DataTableCell><Skeleton width={96} height={18} radius={999} /></DataTableCell>
                <DataTableCell><Skeleton width={120} height={18} radius={999} /></DataTableCell>
                <DataTableCell><Skeleton width={72} height={18} radius={999} /></DataTableCell>
                <DataTableCell><Skeleton width={100} height={12} /></DataTableCell>
                <DataTableCell className={styles.actionsCell}><Skeleton width={24} height={24} radius={6} /></DataTableCell>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      ) : users.length > 0 ? (
        <DataTable aria-label="Visitors" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">Visitor</DataTableHeader>
              <DataTableHeader scope="col">Role</DataTableHeader>
              <DataTableHeader scope="col">Groups</DataTableHeader>
              <DataTableHeader scope="col">Status</DataTableHeader>
              <DataTableHeader scope="col">Created</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {users.map((user) => {
              const label = displayName(user)
              const locked = isLocked(user)
              return (
                <DataTableRow key={user.id} aria-label={`Visitor ${user.email}`}>
                  <DataTableCell>
                    <div className={styles.identity}>
                      <strong>{label}</strong>
                      <span>{user.email}</span>
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        className={styles.memberId}
                        onClick={() => void copyMemberId(user)}
                        aria-label={`Copy member ID ${user.id}`}
                        tooltip="Copy member ID (cross-system identifier)"
                      >
                        <code>{user.id}</code>
                        {copiedId === user.id ? <CheckIcon size={12} aria-hidden="true" /> : <CopySolidIcon size={12} aria-hidden="true" />}
                      </Button>
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    <Select
                      fieldSize="sm"
                      value={user.roleId}
                      options={roleOptionsFor(roles, user.roleId)}
                      onChange={(event) => void changeRole(user, event.target.value)}
                      disabled={busyId === user.id}
                      aria-label={`Role for ${label}`}
                      className={styles.roleSelect}
                    />
                  </DataTableCell>
                  <DataTableCell>
                    <GroupsCell
                      userMemberships={memberships[user.id]}
                      onAssign={() => setAssignTarget(user)}
                    />
                  </DataTableCell>
                  <DataTableCell>
                    <div className={styles.badges}>
                      <TagPill
                        label={user.status === 'active' ? 'Active' : 'Suspended'}
                        muted={user.status !== 'active'}
                        size="xs"
                      />
                      {locked && <TagPill label="Locked" muted size="xs" />}
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        disabled={busyId === user.id}
                        onClick={() => void toggleStatus(user)}
                        aria-label={user.status === 'active' ? `Suspend ${label}` : `Activate ${label}`}
                      >
                        {user.status === 'active' ? (
                          <PowerOffIcon size={12} aria-hidden="true" />
                        ) : (
                          <PowerIcon size={12} aria-hidden="true" />
                        )}
                        <span>{user.status === 'active' ? 'Suspend' : 'Activate'}</span>
                      </Button>
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    <span className={styles.secondaryText}>{formatDate(user.createdAt)}</span>
                  </DataTableCell>
                  <DataTableCell className={styles.actionsCell}>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Edit profile for ${label}`}
                      onClick={() => setProfileTarget(user)}
                    >
                      <EditSolidIcon size={12} aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      iconOnly
                      type="button"
                      aria-label={`Delete ${label}`}
                      onClick={() => setPendingDelete(user)}
                    >
                      <TrashSolidIcon size={12} aria-hidden="true" />
                    </Button>
                  </DataTableCell>
                </DataTableRow>
              )
            })}
          </DataTableBody>
        </DataTable>
      ) : (
        <p className={styles.emptyState}>
          {search.trim() ? 'No visitors match your search.' : 'No visitors yet.'}
        </p>
      )}

      {assignTarget && (
        <AssignGroupsDialog
          key={assignTarget.id}
          user={assignTarget}
          groups={groups}
          onClose={() => setAssignTarget(null)}
          onSaved={(result) => handleAssignSaved(assignTarget.id, result)}
        />
      )}

      {profileTarget && (
        <EditProfileDialog
          key={profileTarget.id}
          user={profileTarget}
          onClose={() => setProfileTarget(null)}
          onSaved={(profileFields) => handleProfileSaved(profileTarget.id, profileFields)}
        />
      )}

      {pendingDelete && (
        <Dialog
          open
          onClose={deleting ? () => {} : () => setPendingDelete(null)}
          tone="danger"
          eyebrow="Delete visitor"
          title={pendingDelete.email}
          footer={
            <>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete visitor'}
              </Button>
            </>
          }
        >
          <p>
            Permanently delete the visitor account for{' '}
            <strong>{pendingDelete.email}</strong>? Their active sessions are
            revoked immediately and they will no longer be able to sign in.
          </p>
        </Dialog>
      )}
    </section>
  )
}
