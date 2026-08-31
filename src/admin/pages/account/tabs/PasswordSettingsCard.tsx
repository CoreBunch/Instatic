import { useId, useState, type FormEvent } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { changeCurrentUserPassword } from '@core/persistence'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { SecurityCard } from './SecurityCard'
import { isStepUpCancelled } from './securityErrors'
import { formatDateTime } from '@admin/lib/formatDateTime'
import styles from '../AccountPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface PasswordSettingsCardProps {
  user: CmsCurrentUser
  busy: string | null
  runStepUp: <T>(fn: () => Promise<T>) => Promise<T>
  setSessionUser: (user: CmsCurrentUser) => void
  setBusy: (v: string | null) => void
  setError: (v: string | null) => void
  setStatus: (v: string | null) => void
}

export function PasswordSettingsCard({
  user,
  busy,
  runStepUp,
  setSessionUser,
  setBusy,
  setError,
  setStatus,
}: PasswordSettingsCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const newPasswordId = useId()
  const confirmPasswordId = useId()

  const passwordStatus = user.passwordUpdatedAt
    ? `Last changed: ${formatDateTime(user.passwordUpdatedAt)}`
    : user.lastLoginAt
      ? `Last login: ${formatDateTime(user.lastLoginAt)}`
      : 'Password has not been used yet.'

  function resetDialog(): void {
    setDialogOpen(false)
    setNewPassword('')
    setConfirmPassword('')
    setPasswordError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) return
    setPasswordError(null)
    setError(null)
    setStatus(null)
    if (newPassword.length < 12) {
      setPasswordError('Password must be at least 12 characters.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.')
      return
    }

    setBusy('password')
    try {
      const updated = await runStepUp(() => changeCurrentUserPassword({ newPassword }))
      setSessionUser(updated)
      resetDialog()
      setStatus('Password updated. Other devices were signed out.')
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        setPasswordError(getErrorMessage(err, 'Could not update password.'))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SecurityCard
        testId="security-password-card"
        title="Password"
        description="Change your password. Other devices are signed out after a successful update."
        status={passwordStatus}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => setDialogOpen(true)}
            data-testid="security-change-password"
          >
            <span>Change password</span>
          </Button>
        }
      />

      <Dialog
        open={dialogOpen}
        onClose={resetDialog}
        title="Change password"
        size="md"
        footer={
          <>
            <Button type="button" variant="secondary" size="sm" disabled={busy === 'password'} onClick={resetDialog}>
              <span>Cancel</span>
            </Button>
            <Button
              type="submit"
              form="security-password-form"
              variant="primary"
              size="sm"
              disabled={busy === 'password'}
              data-testid="security-password-submit"
            >
              <span>{busy === 'password' ? 'Saving...' : 'Save password'}</span>
            </Button>
          </>
        }
      >
        <form id="security-password-form" className={styles.dialogFields} onSubmit={(event) => void handleSubmit(event)}>
          <div className={styles.dialogField}>
            <label htmlFor={newPasswordId} className={styles.dialogLabel}>New password</label>
            <Input
              id={newPasswordId}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.currentTarget.value)}
              data-testid="security-password-new"
            />
          </div>
          <div className={styles.dialogField}>
            <label htmlFor={confirmPasswordId} className={styles.dialogLabel}>Confirm new password</label>
            <Input
              id={confirmPasswordId}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.currentTarget.value)}
              data-testid="security-password-confirm"
            />
          </div>
          {passwordError && <p className={styles.error} role="alert">{passwordError}</p>}
        </form>
      </Dialog>
    </>
  )
}
