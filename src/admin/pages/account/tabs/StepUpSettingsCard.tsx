import { useId, useState } from 'react'
import { Button } from '@ui/components/Button'
import type { CmsStepUpAuthMode, CmsStepUpWindowMinutes } from '@core/persistence'
import { updateCurrentUserStepUpSettings } from '@core/persistence'
import { Select } from '@ui/components/Select'
import { Switch } from '@ui/components/Switch'
import { AccountRow } from './AccountRow'
import { type AccountSecurityProps, reportSecurityError, reportSecuritySuccess } from './securityFeedback'
import { isStepUpCancelled } from './securityErrors'
import styles from '../AccountPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

const STEP_UP_WINDOW_OPTIONS = [
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '60 minutes' },
]

function parseStepUpWindowMinutes(value: string): CmsStepUpWindowMinutes | null {
  if (value === '5') return 5
  if (value === '15') return 15
  if (value === '30') return 30
  if (value === '60') return 60
  return null
}

async function updateStepUpSettings(
  input: {
    mode: CmsStepUpAuthMode
    windowMinutes: CmsStepUpWindowMinutes
  },
  props: AccountSecurityProps,
): Promise<void> {
  const { runStepUp, setSessionUser, setBusy } = props
  try {
    const updated = await runStepUp(() => updateCurrentUserStepUpSettings(input))
    setSessionUser(updated)
    reportSecuritySuccess(
      updated.stepUpAuthMode === 'required'
        ? `Step-up authentication updated to ${updated.stepUpWindowMinutes} minutes.`
        : 'Step-up authentication disabled.',
    )
  } catch (err) {
    if (!isStepUpCancelled(err)) {
      reportSecurityError(getErrorMessage(err, 'Could not update step-up authentication.'))
    }
  } finally {
    setBusy(null)
  }
}

export function StepUpSettingsCard(props: AccountSecurityProps) {
  const { user, busy, setBusy } = props
  const [editing, setEditing] = useState(false)
  const controlsId = useId()
  const stepUpEnabled = user.stepUpAuthMode === 'required'
  const stepUpStatus = stepUpEnabled
    ? `Ask for your password again after ${user.stepUpWindowMinutes} minutes.`
    : 'Off'

  async function handleModeChange(checked: boolean): Promise<void> {
    if (busy) return
    const mode: CmsStepUpAuthMode = checked ? 'required' : 'disabled'
    if (mode === user.stepUpAuthMode) return
    setBusy('step-up')
    await updateStepUpSettings({ mode, windowMinutes: user.stepUpWindowMinutes }, props)
  }

  async function handleWindowChange(value: string): Promise<void> {
    if (busy) return
    const windowMinutes = parseStepUpWindowMinutes(value)
    if (windowMinutes === null || windowMinutes === user.stepUpWindowMinutes) return
    setBusy('step-up-window')
    await updateStepUpSettings({ mode: user.stepUpAuthMode, windowMinutes }, props)
  }

  return (
    <div data-testid="security-step-up-card">
      <AccountRow
        title="Confirm sensitive actions"
        status={stepUpStatus}
        action={
          <Button
            variant="secondary"
            size="md"
            aria-label="Edit sensitive action confirmation"
            aria-expanded={editing}
            aria-controls={editing ? controlsId : undefined}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Done' : 'Edit'}
          </Button>
        }
      />
      {editing && (
        <div id={controlsId} className={styles.policyEditor}>
          <p className={styles.secondaryText}>Require a password check before sensitive account and publishing actions.</p>
          <div className={styles.stepUpControls}>
            <div className={styles.switchControl}>
              <Switch
                checked={stepUpEnabled}
                disabled={busy !== null}
                switchSize="sm"
                onCheckedChange={(checked) => void handleModeChange(checked)}
                aria-label="Require step-up authentication"
                data-testid="security-step-up-toggle"
              />
              <span>{stepUpEnabled ? 'Required' : 'Disabled'}</span>
            </div>
            <Select
              value={String(user.stepUpWindowMinutes)}
              options={STEP_UP_WINDOW_OPTIONS}
              fieldSize="sm"
              disabled={busy !== null || !stepUpEnabled}
              aria-label="Step-up window"
              data-testid="security-step-up-window"
              onChange={(event) => void handleWindowChange(event.currentTarget.value)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
