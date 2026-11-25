import { useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { changeCurrentUserPassword, updateCurrentUserProfile } from '@core/persistence'
import { isValidEmail } from '@core/utils/email'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { AccountRow } from './AccountRow'
import { isStepUpCancelled } from './securityErrors'
import { formatSecurityDate } from './securityFormat'
import { type AccountSecurityProps, reportSecurityError, reportSecuritySuccess } from './securityFeedback'
import styles from '../AccountPage.module.css'

type SignInField = 'email' | 'password'

interface SignInRowProps extends AccountSecurityProps {
  field: SignInField
}

export function SignInRow(props: SignInRowProps) {
  const { field, user, busy } = props
  const [editing, setEditing] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const title = field === 'email' ? 'Email' : 'Password'
  const formId = useId()

  useLayoutEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false
      trigger.current?.focus()
    }
  }, [editing])

  function closeEditor() {
    restoreFocus.current = true
    setEditing(false)
  }

  let status = user.email
  if (field === 'password') {
    status = user.passwordUpdatedAt
      ? `Last changed: ${formatSecurityDate(user.passwordUpdatedAt)}`
      : user.lastLoginAt ? `Last login: ${formatSecurityDate(user.lastLoginAt)}` : 'Password has not been used yet.'
  }

  return (
    <AccountRow
      title={title}
      status={status}
      testId={field === 'password' ? 'security-password-card' : 'account-email-row'}
      action={
        <Button
          ref={trigger}
          variant="secondary"
          disabled={busy !== null}
          aria-expanded={editing}
          data-testid={field === 'password' ? 'security-change-password' : undefined}
          onClick={() => setEditing(true)}
        >
          Change {field}
        </Button>
      }
      editor={editing && <SignInForm {...props} id={formId} onClose={closeEditor} />}
    />
  )
}

interface SignInFormProps extends SignInRowProps {
  id: string
  onClose: () => void
}

function SignInForm({ field, user, busy, setBusy, setSessionUser, runStepUp, id, onClose }: SignInFormProps) {
  const isEmail = field === 'email'
  const [value, setValue] = useState(isEmail ? user.email : '')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<{ field: 'value' | 'confirmation'; message: string } | null>(null)
  const firstField = useRef<HTMLInputElement>(null)

  const confirmField = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => { firstField.current?.focus() }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    if (isEmail && !isValidEmail(value.trim())) {
      setError({ field: 'value', message: 'Enter a valid email address.' })
      firstField.current?.focus()
      return
    }
    if (!isEmail && value.length < 12) {
      setError({ field: 'value', message: 'Password must be at least 12 characters.' })
      firstField.current?.focus()
      return
    }
    const matches = isEmail
      ? value.trim().toLowerCase() === confirmation.trim().toLowerCase()
      : value === confirmation
    if (!matches) {
      const message = isEmail ? 'Email addresses do not match.' : 'Passwords do not match.'
      setError({ field: 'confirmation', message })
      confirmField.current?.focus()
      return
    }

    setError(null)
    setBusy(field)
    try {
      const updated = await runStepUp(() => isEmail
        ? updateCurrentUserProfile({ displayName: user.displayName, email: value.trim() })
        : changeCurrentUserPassword({ newPassword: value }))
      setSessionUser(updated)
      reportSecuritySuccess(isEmail ? 'Email updated.' : 'Password updated. Other devices were signed out.')
      onClose()
    } catch (err) {
      if (!isStepUpCancelled(err)) reportSecurityError(getErrorMessage(err, `Could not update ${field}.`))
    } finally {
      setBusy(null)
    }
  }

  return (
    <form
      id={id}
      noValidate
      aria-label={`Change ${field}`}
      className={styles.signInEditor}
      onSubmit={submit}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing || busy) return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <div className={styles.dialogField}>
        <label htmlFor={id + '-value'} className={styles.dialogLabel}>{isEmail ? 'New email address' : 'New password'}</label>
        <Input
          ref={firstField}
          id={id + '-value'}
          type={isEmail ? 'email' : 'password'}
          autoComplete={isEmail ? 'email' : 'new-password'}
          value={value}
          disabled={busy !== null}
          required
          aria-invalid={error?.field === 'value' || undefined}
          aria-describedby={error?.field === 'value' ? id + '-error' : id + '-hint'}
          onChange={event => { setValue(event.currentTarget.value); setError(null) }}
          data-testid={isEmail ? 'profile-email' : 'security-password-new'}
        />
        {error?.field === 'value' && <p id={id + '-error'} className={styles.error} role="alert">{error.message}</p>}
      </div>
      <div className={styles.dialogField}>
        <label htmlFor={id + '-confirm'} className={styles.dialogLabel}>
          {isEmail ? 'Confirm new email address' : 'Confirm new password'}
        </label>
        <Input
          ref={confirmField}
          id={id + '-confirm'}
          type={isEmail ? 'email' : 'password'}
          autoComplete={isEmail ? 'off' : 'new-password'}
          value={confirmation}
          disabled={busy !== null}
          required
          aria-invalid={error?.field === 'confirmation' || undefined}
          aria-describedby={error?.field === 'confirmation' ? id + '-error' : undefined}
          onChange={event => { setConfirmation(event.currentTarget.value); setError(null) }}
          data-testid={isEmail ? undefined : 'security-password-confirm'}
        />
        {error?.field === 'confirmation' && <p id={id + '-error'} className={styles.error} role="alert">{error.message}</p>}
      </div>
      <p id={id + '-hint'} className={styles.secondaryText}>
        {isEmail ? 'Use this address the next time you sign in.' : 'Use at least 12 characters. Changing your password signs out your other devices.'}
      </p>
      <div className={styles.editorActions}>
        <Button
          type="submit"
          variant="primary"
          busy={busy === field}
          disabled={busy !== null || (isEmail && value.trim() === user.email)}
          data-testid={isEmail ? undefined : 'security-password-submit'}
        >
          Save {field}
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={onClose}>Cancel</Button>
      </div>
    </form>
  )
}
