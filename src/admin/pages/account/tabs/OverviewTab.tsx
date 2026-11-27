import { useState } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import { useAdminSessionSetter } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { ProfileHeader } from './ProfileHeader'
import { MfaSettingsCards } from './MfaSettingsCards'
import { SignInRow } from './SignInRow'
import { StepUpSettingsCard } from './StepUpSettingsCard'
import styles from '../AccountPage.module.css'

export function OverviewTab({ user }: { user: CmsCurrentUser }) {
  const { runStepUp } = useStepUp()
  const setSessionUser = useAdminSessionSetter()
  const [busy, setBusy] = useState<string | null>(null)
  const security = { user, busy, setBusy, runStepUp, setSessionUser }

  return (
    <div className={styles.overview}>
      <ProfileHeader user={user} />
      <section className={styles.rowGroup} aria-label="Sign-in details">
        <h2>Sign-in details</h2>
        <SignInRow {...security} field="email" />
        <SignInRow {...security} field="password" />
      </section>
      <section className={styles.rowGroup} aria-label="Account protection">
        <h2>Account protection</h2>
        <MfaSettingsCards {...security} />
        <StepUpSettingsCard {...security} />
      </section>
    </div>
  )
}
