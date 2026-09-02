import { useState } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { Button } from '@ui/components/Button'
import { useAdminSessionSetter } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { MfaSettingsCards } from './MfaSettingsCards'
import { PasswordSettingsCard } from './PasswordSettingsCard'
import { SecurityCard } from './SecurityCard'
import { StepUpSettingsCard } from './StepUpSettingsCard'
import styles from '../AccountPage.module.css'

interface SecurityTabProps {
  user: CmsCurrentUser
}

export function SecurityTab({ user }: SecurityTabProps) {
  const { runStepUp } = useStepUp()
  const setSessionUser = useAdminSessionSetter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const connectedSignInsStatus = 'Email + password is the only sign-in method right now.'

  return (
    <section className={styles.section} aria-labelledby="account-security-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="account-security-title">Security</h2>
          <p>Password, step-up authentication, two-factor authentication, and connected sign-ins.</p>
        </div>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {status && <p className={styles.cardStatus} role="status">{status}</p>}

      <div className={styles.cards}>
        <PasswordSettingsCard
          user={user}
          busy={busy}
          runStepUp={runStepUp}
          setSessionUser={setSessionUser}
          setBusy={setBusy}
          setError={setError}
          setStatus={setStatus}
        />
        <StepUpSettingsCard
          user={user}
          busy={busy}
          runStepUp={runStepUp}
          setSessionUser={setSessionUser}
          setBusy={setBusy}
          setError={setError}
          setStatus={setStatus}
        />
        <MfaSettingsCards
          user={user}
          busy={busy}
          runStepUp={runStepUp}
          setSessionUser={setSessionUser}
          setBusy={setBusy}
          setError={setError}
          setStatus={setStatus}
        />
        <SecurityCard
          testId="security-connected-card"
          title="Connected sign-ins"
          description="OAuth providers and passkeys you can use alongside your password."
          status={connectedSignInsStatus}
          action={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled
              tooltip="OAuth and passkeys are a separate sign-in provider pass."
            >
              <span>Add provider</span>
            </Button>
          }
        />
      </div>
    </section>
  )
}
