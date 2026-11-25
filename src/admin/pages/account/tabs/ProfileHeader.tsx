import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { deleteCurrentUserAvatar, updateCurrentUserProfile, uploadCurrentUserAvatar, type CmsCurrentUser } from '@core/persistence'
import { userDisplayLabel } from '@core/users/displayName'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAdminSessionSetter } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { UserAvatar } from '@admin/shared/UserAvatar'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { isStepUpCancelled } from './securityErrors'
import styles from '../AccountPage.module.css'

export function ProfileHeader({ user }: { user: CmsCurrentUser }) {
  const [editing, setEditing] = useState(false)

  return (
    <div className={styles.profileHeader}>
      <UserAvatar key={user.avatarUrl ?? user.gravatarHash} user={user} size={60} alt={null} className={styles.avatar} />
      <div className={styles.identity}>
        <h2>{userDisplayLabel(user)}</h2>
        <span>{user.role.name}</span>
      </div>
      <Button variant="secondary" size="md" onClick={() => setEditing(true)}>Edit profile</Button>
      {editing && <ProfileDialog user={user} onClose={() => setEditing(false)} />}
    </div>
  )
}

function ProfileDialog({ user, onClose }: { user: CmsCurrentUser; onClose: () => void }) {
  const setSessionUser = useAdminSessionSetter()
  const { runStepUp } = useStepUp()
  const [name, setName] = useState(user.displayName)
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const formId = useId()
  const nameId = useId()
  const dirty = name.trim() !== user.displayName

  async function updatePicture(file: File | null) {
    if (busy) return
    setBusy(true)
    try {
      const updated = file ? await uploadCurrentUserAvatar(file) : await deleteCurrentUserAvatar()
      setSessionUser(updated)
      pushToast({ kind: 'success', title: file ? 'Profile picture updated.' : 'Profile picture removed.' })
    } catch (err) {
      pushToast({ kind: 'error', title: 'Picture update failed', body: getErrorMessage(err, 'Could not update picture.') })
    } finally {
      setBusy(false)
    }
  }

  function selectPicture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) void updatePicture(file)
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const updated = await runStepUp(() => updateCurrentUserProfile({ displayName: name, email: user.email }))
      setSessionUser(updated)
      pushToast({ kind: 'success', title: 'Profile saved.' })
      onClose()
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        pushToast({ kind: 'error', title: 'Profile update failed', body: getErrorMessage(err, 'Could not save profile.') })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open title="Edit profile" onClose={() => { if (!busy) onClose() }} footer={
      <>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>Close</Button>
        <Button variant="primary" size="sm" type="submit" form={formId} disabled={busy || !dirty} data-testid="profile-save">Save profile</Button>
      </>
    }>
      <form id={formId} className={styles.dialogFields} onSubmit={saveProfile}>
        <div className={styles.pictureEditor}>
          <UserAvatar key={user.avatarUrl} user={user} size={48} alt={null} className={styles.avatar} />
          <div className={styles.pictureActions}>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="profile-avatar-upload">
              {user.avatarUrl ? 'Change picture' : 'Upload picture'}
            </Button>
            {user.avatarUrl && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void updatePicture(null)} data-testid="profile-avatar-remove">Remove</Button>}
          </div>
          <input type="file" hidden ref={fileInput} accept="image/jpeg,image/png,image/gif,image/webp" onChange={selectPicture} data-testid="profile-avatar-file" />
        </div>
        <p className={styles.secondaryText}>JPEG, PNG, GIF, or WebP, 5 MB maximum.</p>
        <div className={styles.dialogField}>
          <label htmlFor={nameId} className={styles.dialogLabel}>Display name</label>
          <Input id={nameId} autoComplete="name" value={name} onChange={e => setName(e.currentTarget.value)} disabled={busy} data-testid="profile-display-name" />
        </div>
      </form>
    </Dialog>
  )
}
