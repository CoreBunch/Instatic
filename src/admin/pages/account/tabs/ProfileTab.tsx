/**
 * Account → Profile tab.
 *
 * Shows the current user's identity (avatar + display name + email + role)
 * and lets them edit profile basics or upload/remove a profile picture.
 * Without an upload, the avatar falls back to the deterministic Gravatar
 * identicon derived from the user's email, so every user has a recognisable
 * picture out of the box.
 */
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import {
  deleteCurrentUserAvatar,
  updateCurrentUserProfile,
  uploadCurrentUserAvatar,
  type CmsCurrentUser,
} from '@core/persistence'
import { isValidEmail } from '@core/utils/email'
import { useAdminSessionSetter } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { UserAvatar } from '@admin/shared/UserAvatar'
import styles from '../AccountPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'
import { isStepUpCancelled } from './securityErrors'

interface ProfileTabProps {
  user: CmsCurrentUser
}

type ProfileBusy = null | 'profile' | 'upload' | 'remove'
type ProfileStatus = { tone: 'info' | 'error'; message: string } | null
type ProfileForm = { displayName: string; email: string }

async function uploadAvatarHelper(
  file: File,
  setBusy: (v: ProfileBusy) => void,
  setSessionUser: (user: CmsCurrentUser) => void,
  setStatus: (v: ProfileStatus) => void,
): Promise<void> {
  try {
    const updated = await uploadCurrentUserAvatar(file)
    setSessionUser(updated)
    setStatus({ tone: 'info', message: 'Profile picture updated.' })
  } catch (err) {
    console.error('[profile-tab] avatar upload failed:', err)
    setStatus({
      tone: 'error',
      message: getErrorMessage(err, 'Could not upload avatar.'),
    })
  } finally {
    setBusy(null)
  }
}

async function removeAvatarHelper(
  setBusy: (v: ProfileBusy) => void,
  setSessionUser: (user: CmsCurrentUser) => void,
  setStatus: (v: ProfileStatus) => void,
): Promise<void> {
  try {
    const updated = await deleteCurrentUserAvatar()
    setSessionUser(updated)
    setStatus({ tone: 'info', message: 'Profile picture removed.' })
  } catch (err) {
    console.error('[profile-tab] avatar remove failed:', err)
    setStatus({
      tone: 'error',
      message: getErrorMessage(err, 'Could not remove avatar.'),
    })
  } finally {
    setBusy(null)
  }
}

export function ProfileTab({ user }: ProfileTabProps) {
  const setSessionUser = useAdminSessionSetter()
  const { runStepUp } = useStepUp()
  const [busy, setBusy] = useState<ProfileBusy>(null)
  const [status, setStatus] = useState<ProfileStatus>(null)
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    displayName: user.displayName,
    email: user.email,
  })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const displayNameId = useId()
  const emailId = useId()

  const displayName = user.displayName.trim() || user.email
  const hasUploadedAvatar = user.avatarUrl !== null
  const profileDirty =
    profileForm.displayName.trim() !== user.displayName ||
    profileForm.email.trim() !== user.email

  function openFilePicker(): void {
    if (busy) return
    fileInputRef.current?.click()
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    // Reset the value so picking the same filename twice still fires
    // `change` — needed for re-upload after an error.
    event.target.value = ''
    if (!file) return

    setBusy('upload')
    setStatus(null)
    await uploadAvatarHelper(file, setBusy, setSessionUser, setStatus)
  }

  async function handleRemove(): Promise<void> {
    if (busy) return
    setBusy('remove')
    setStatus(null)
    await removeAvatarHelper(setBusy, setSessionUser, setStatus)
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) return

    const email = profileForm.email.trim()
    if (!isValidEmail(email)) {
      setStatus({ tone: 'error', message: 'Enter a valid email address.' })
      return
    }

    setBusy('profile')
    setStatus(null)
    try {
      const updated = await runStepUp(() => updateCurrentUserProfile({
        displayName: profileForm.displayName,
        email,
      }))
      setSessionUser(updated)
      setProfileForm({
        displayName: updated.displayName,
        email: updated.email,
      })
      setStatus({ tone: 'info', message: 'Profile saved.' })
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        console.error('[profile-tab] profile update failed:', err)
        setStatus({
          tone: 'error',
          message: getErrorMessage(err, 'Could not save profile.'),
        })
      }
    }
    setBusy(null)
  }

  return (
    <section className={styles.section} aria-labelledby="account-profile-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="account-profile-title">Profile</h2>
          <p>Your name, email, and role across the install.</p>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.profileGrid}>
          <div className={styles.avatarColumn}>
            <UserAvatar user={user} size={96} alt={`Avatar for ${displayName}`} />
            <div className={styles.avatarActions}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={openFilePicker}
                disabled={busy !== null}
                aria-busy={busy === 'upload'}
                data-testid="profile-avatar-upload"
              >
                <span>
                  {busy === 'upload'
                    ? 'Uploading…'
                    : hasUploadedAvatar
                      ? 'Change picture'
                      : 'Upload picture'}
                </span>
              </Button>
              {hasUploadedAvatar && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  tone="danger"
                  onClick={() => void handleRemove()}
                  disabled={busy !== null}
                  aria-busy={busy === 'remove'}
                  data-testid="profile-avatar-remove"
                >
                  <span>{busy === 'remove' ? 'Removing…' : 'Remove'}</span>
                </Button>
              )}
            </div>
            <p className={styles.avatarHint}>JPEG, PNG, GIF, or WebP, 5 MB maximum.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className={styles.hiddenFileInput}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void handleFileChange(event)}
              data-testid="profile-avatar-file"
            />
          </div>
          <form className={styles.profileForm} onSubmit={(event) => void handleProfileSubmit(event)}>
            <div className={styles.profileFields}>
              <div className={styles.profileField}>
                <label className={styles.profileFieldLabel} htmlFor={displayNameId}>Name</label>
                <Input
                  id={displayNameId}
                  value={profileForm.displayName}
                  name="current-user-display-name"
                  autoComplete="name"
                  data-testid="profile-display-name"
                  disabled={busy !== null}
                  onChange={(event) => {
                    setProfileForm({ ...profileForm, displayName: event.currentTarget.value })
                  }}
                />
              </div>
              <div className={styles.profileField}>
                <label className={styles.profileFieldLabel} htmlFor={emailId}>Email</label>
                <Input
                  id={emailId}
                  type="email"
                  value={profileForm.email}
                  name="current-user-email-address"
                  autoComplete="email"
                  data-testid="profile-email"
                  required
                  disabled={busy !== null}
                  onChange={(event) => {
                    setProfileForm({ ...profileForm, email: event.currentTarget.value })
                  }}
                />
              </div>
              <div className={styles.profileField}>
                <span className={styles.profileFieldLabel}>Role</span>
                <span className={styles.profileFieldValue}>{user.role.name}</span>
              </div>
            </div>
            <div className={styles.profileActions}>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={busy !== null || !profileDirty}
                aria-busy={busy === 'profile'}
                data-testid="profile-save"
              >
                <span>{busy === 'profile' ? 'Saving…' : 'Save profile'}</span>
              </Button>
            </div>
          </form>
        </div>
        {status && (
          <p
            className={status.tone === 'error' ? styles.error : styles.cardStatus}
            role={status.tone === 'error' ? 'alert' : 'status'}
            data-testid="profile-status"
          >
            {status.message}
          </p>
        )}
      </div>
    </section>
  )
}
