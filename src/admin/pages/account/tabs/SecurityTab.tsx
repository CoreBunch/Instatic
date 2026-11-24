import { useState } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { useAdminSessionSetter } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { MfaSettingsCards } from './MfaSettingsCards'
import { PasswordSettingsCard } from './PasswordSettingsCard'
import { StepUpSettingsCard } from './StepUpSettingsCard'
import { WorkspaceSection } from '@admin/shared/SettingsWorkspace/WorkspaceSection'
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

  return (
    <WorkspaceSection title="Security">
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
      </div>
    </WorkspaceSection>
  )
}
