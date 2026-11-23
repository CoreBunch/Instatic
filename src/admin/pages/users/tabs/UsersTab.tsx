/**
 * Users → Users tab.
 *
 * Lists every CMS user with their role, status and last-login time. The
 * inspector exposes Edit / Reset password / Suspend (or
 * Activate) / Delete. The owner row has no actions — owner accounts are
 * permanent and immutable from the admin UI.
 *
 * Every mutation goes through `runStepUp` so the server-side step-up auth
 * gate gets a chance to re-prompt for the admin's password if the session
 * has no fresh window. Cancelling the step-up dialog resolves silently
 * (we match on `StepUpCancelledMessage`).
 */
import { useEffect, useEffectEvent, useState, type FormEvent } from 'react'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { useDebouncedValue } from '@admin/lib/useDebouncedValue'
import { useDirectoryPage } from '../hooks/useDirectoryPage'
import { AccountDirectory } from '../components/AccountDirectory'
import directory from '@admin/shared/Directory/Directory.module.css'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import {
  listCmsUsers,
  createCmsUser,
  deleteCmsUser,
  updateCmsUser,
  type CmsCurrentUser,
} from '@core/persistence'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { Badge } from '../components/Badge'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { UserDialog } from '../components/UserDialog'
import { userDisplayLabel } from '@core/users/displayName'
import { formatDateTime, isOwnerUser } from '../utils/format'
import {
  emptyUserForm,
  type UserDialogMode,
  type UserFormState,
} from '../types'
import type { UsersPageData } from '../hooks/useUsersPageData'
import styles from '../UsersPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import { EmptyState } from '@ui/components/EmptyState'
import { UsersSolidIcon } from 'pixel-art-icons/icons/users-solid'

interface UsersTabProps {
  data: UsersPageData
  canManageUsers: boolean
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active', textValue: 'Active' },
  { value: 'suspended', label: 'Suspended', textValue: 'Suspended' },
] as const

async function saveUser(
  dialogMode: UserDialogMode,
  editingUserId: string | null,
  userForm: UserFormState,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  closeDialog: () => void,
  refresh: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    if (dialogMode === 'reset') {
      if (!editingUserId) throw new Error('No user selected')
      await runStepUp(() => updateCmsUser(editingUserId, { password: userForm.password }))
    } else if (dialogMode === 'edit') {
      if (!editingUserId) throw new Error('No user selected')
      await runStepUp(() => updateCmsUser(editingUserId, {
        email: userForm.email,
        displayName: userForm.displayName,
        roleId: userForm.roleId,
        status: userForm.status,
        ...(userForm.password ? { password: userForm.password } : {}),
      }))
    } else {
      await runStepUp(() => createCmsUser({
        email: userForm.email,
        displayName: userForm.displayName,
        password: userForm.password,
        roleId: userForm.roleId,
      }))
    }
    closeDialog()
    void refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setError(getErrorMessage(err, 'Could not save user'))
  } finally {
    setBusy(false)
  }
}

async function toggleUserStatus(
  userId: string,
  currentStatus: string,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  refresh: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await runStepUp(() => updateCmsUser(userId, {
      status: currentStatus === 'active' ? 'suspended' : 'active',
    }))
    void refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setError(getErrorMessage(err, 'Could not update user'))
  } finally {
    setBusy(false)
  }
}

async function deleteUser(
  userId: string,
  runStepUp: <T>(action: () => Promise<T>) => Promise<T>,
  refresh: () => void,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await runStepUp(() => deleteCmsUser(userId))
    void refresh()
  } catch (err) {
    if (err instanceof Error && err.message === StepUpCancelledMessage) return
    setError(getErrorMessage(err, 'Could not delete user'))
  } finally {
    setBusy(false)
  }
}

export function UsersTab({ data, canManageUsers }: UsersTabProps) {
  const { roles, defaultAssignableRoleId, setError, error } = data
  const { runStepUp } = useStepUp()
  const confirmDelete = useConfirmDelete()
  const [busy, setBusy] = useState(false)
  const [userForm, setUserForm] = useState<UserFormState>(() => ({
    ...emptyUserForm,
    roleId: defaultAssignableRoleId,
  }))
  const [dialogMode, setDialogMode] = useState<UserDialogMode | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const query = useDebouncedValue(search.trim(), 250)
  const list = useDirectoryPage(query, (offset, signal) => listCmsUsers({ offset, search: query, signal }), 'Could not load users')
  const users = list.data?.users ?? []
  const selected = users.find((user) => user.id === selectedId)
  const accounts = users.map((user) => ({
    id: user.id,
    name: userDisplayLabel(user),
    email: user.email,
    avatar: <UserAvatar className={directory.avatar} user={user} size={32} alt={null} />,
    access: <Badge label={user.role.name} muted />,
    status: user.status,
    lastLogin: user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'Never',
  }))

  const assignableRoleOptions = roles
    .filter((role) => role.id !== 'owner')
    .map((role) => ({ value: role.id, label: role.name, textValue: role.name }))

  function closeDialog() {
    setDialogMode(null)
    setEditingUserId(null)
    setUserForm({ ...emptyUserForm, roleId: defaultAssignableRoleId })
  }

  function openCreate() {
    if (!canManageUsers) return
    setEditingUserId(null)
    setUserForm({ ...emptyUserForm, roleId: defaultAssignableRoleId })
    setDialogMode('create')
    setError(null)
  }

  // Auto-open the invite dialog when the spotlight queued a `users.invite`
  // action while the user was on a different workspace. Only consume the
  // action once `canManageUsers` is true — otherwise openCreate's capability
  // guard would swallow the action and we'd have spent it for nothing.
  // We use queueMicrotask (not setTimeout) so the setState fires on the same
  // task: setTimeout(0) cleanup can race the timer when a fast navigation
  // tears the tab back down before the macrotask runs, which would lose
  // the dialog.
  // useEffectEvent reads the latest openCreate without putting it in the
  // effect's dep array — openCreate is recreated each render, but the
  // effect should only fire when canManageUsers flips on.
  const consumeInvitePending = useEffectEvent(() => {
    const pending = consumePendingAction('users.invite')
    if (!pending) return
    queueMicrotask(() => openCreate())
  })

  useEffect(() => {
    if (!canManageUsers) return
    consumeInvitePending()
  }, [canManageUsers])

  function openEdit(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    setEditingUserId(user.id)
    setUserForm({
      email: user.email,
      displayName: user.displayName,
      password: '',
      roleId: user.role.id === 'owner' ? defaultAssignableRoleId : user.role.id,
      status: user.status,
    })
    setDialogMode('edit')
    setError(null)
  }

  function openResetPassword(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    setEditingUserId(user.id)
    setUserForm({
      email: user.email,
      displayName: user.displayName,
      password: '',
      roleId: user.role.id === 'owner' ? defaultAssignableRoleId : user.role.id,
      status: user.status,
    })
    setDialogMode('reset')
    setError(null)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManageUsers || !dialogMode) return
    if ((dialogMode === 'create' || dialogMode === 'reset' || userForm.password) && userForm.password.length < 12) {
      setError('Password must be at least 12 characters')
      return
    }
    await saveUser(dialogMode, editingUserId, userForm, runStepUp, closeDialog, list.refresh, setBusy, setError)
  }

  async function toggleStatus(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    await toggleUserStatus(user.id, user.status, runStepUp, list.refresh, setBusy, setError)
  }

  function remove(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    confirmDelete({
      title: `Delete ${userDisplayLabel(user)}?`,
      description: 'This user will lose access to the CMS and their current sessions will end.',
      confirmLabel: 'Delete user',
      alwaysConfirm: true,
      commit: () => void deleteUser(user.id, runStepUp, list.refresh, setBusy, setError),
    })
  }

  return (
    <section className={styles.section} aria-labelledby="all-users-title">
      <div className={styles.sectionHeader}>
        <h1 id="all-users-title">Admin users</h1>
        {canManageUsers && (
          <Button type="button" variant="primary" size="md" onClick={openCreate}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Create User</span>
          </Button>
        )}
      </div>
      {list.error && <p className={styles.error} role="alert">{list.error}</p>}
      <AccountDirectory
        kind="User"
        accounts={accounts}
        selectedId={selectedId}
        onSelect={setSelectedId}
        loading={list.loading && !list.data}
        pagination={list.pagination}
        toolbar={<SearchBar className={directory.search} value={search} onValueChange={setSearch} onClear={() => setSearch('')}
          placeholder="Search name or email" aria-label="Search name or email" />}
        empty={<EmptyState variant="centered" icon={<UsersSolidIcon size={28} />}
          title={query ? 'No matching users' : 'No users yet'}
          description={query ? 'Try another name or email address.' : 'People you add get their own sign-in to this admin.'}
          action={query && <Button variant="secondary" onClick={() => setSearch('')}>Clear search</Button>} />}
      >
        {selected && (
          <>
            <section className={directory.section}>
              <h4>CMS access</h4>
              <dl className={directory.facts}>
                <div><dt>Role</dt><dd>{selected.role.name}</dd></div>
                <div><dt>Last login</dt><dd>{formatDateTime(selected.lastLoginAt)}</dd></div>
              </dl>
            </section>
            {isOwnerUser(selected) ? <p className={styles.secondaryText}>Owner account</p> : canManageUsers && (
              <div className={directory.actions} role="group" aria-label="User actions">
                <Button variant="secondary" size="md" disabled={busy} onClick={() => openEdit(selected)}>
                  <EditSolidIcon size={14} aria-hidden="true" /> Edit user
                </Button>
                <Button variant="secondary" size="md" disabled={busy} onClick={() => openResetPassword(selected)}>
                  Reset password
                </Button>
                <Button variant="ghost" size="md" disabled={busy} onClick={() => void toggleStatus(selected)}>
                  {selected.status === 'active' ? 'Suspend' : 'Activate'}
                </Button>
                <Button variant="ghost" size="md" tone="danger" disabled={busy} onClick={() => remove(selected)}>
                  <TrashSolidIcon size={14} aria-hidden="true" /> Delete user
                </Button>
              </div>
            )}
          </>
        )}
      </AccountDirectory>

      {canManageUsers && dialogMode && (
        <UserDialog
          mode={dialogMode}
          form={userForm}
          roleOptions={assignableRoleOptions}
          statusOptions={[...STATUS_OPTIONS]}
          busy={busy}
          error={error}
          onChange={setUserForm}
          onClose={closeDialog}
          onSubmit={handleSave}
        />
      )}
    </section>
  )
}
