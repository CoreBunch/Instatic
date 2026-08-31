import { useEffect, useId, useReducer, type Dispatch, type FormEvent } from 'react'
import type { CmsCurrentUser } from '@core/persistence'
import {
  disableCurrentUserTotp,
  enableCurrentUserTotp,
  regenerateCurrentUserRecoveryCodes,
  startCurrentUserTotpSetup,
} from '@core/persistence'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { SecurityCard } from './SecurityCard'
import { isStepUpCancelled } from './securityErrors'
import { formatDateTime } from '@admin/lib/formatDateTime'
import { copyToClipboard } from '@admin/lib/clipboard'
import styles from '../AccountPage.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface MfaSettingsCardsProps {
  user: CmsCurrentUser
  busy: string | null
  runStepUp: <T>(fn: () => Promise<T>) => Promise<T>
  setSessionUser: (user: CmsCurrentUser) => void
  setBusy: (v: string | null) => void
  setError: (v: string | null) => void
  setStatus: (v: string | null) => void
}

interface TotpSetup {
  secret: string
  otpauthUrl: string
}

interface TotpQrCode {
  otpauthUrl: string
  dataUrl: string
}

interface TotpQrError {
  otpauthUrl: string
  message: string
}

interface MfaState {
  totpSetup: TotpSetup | null
  totpCode: string
  totpQrCode: TotpQrCode | null
  totpQrError: TotpQrError | null
  secretCopied: boolean
  recoveryCodes: string[]
  mfaError: string | null
}

type MfaAction =
  | { type: 'setupStarted'; setup: TotpSetup }
  | { type: 'resetSetup' }
  | { type: 'setTotpCode'; code: string }
  | { type: 'qrRendered'; otpauthUrl: string; dataUrl: string }
  | { type: 'qrFailed'; otpauthUrl: string; message: string }
  | { type: 'copySecretSucceeded' }
  | { type: 'setRecoveryCodes'; recoveryCodes: string[] }
  | { type: 'clearRecoveryCodes' }
  | { type: 'setMfaError'; message: string | null }

const initialMfaState: MfaState = {
  totpSetup: null,
  totpCode: '',
  totpQrCode: null,
  totpQrError: null,
  secretCopied: false,
  recoveryCodes: [],
  mfaError: null,
}

function mfaReducer(state: MfaState, action: MfaAction): MfaState {
  switch (action.type) {
    case 'setupStarted':
      return {
        ...state,
        totpSetup: action.setup,
        totpCode: '',
        totpQrCode: null,
        totpQrError: null,
        secretCopied: false,
        mfaError: null,
      }
    case 'resetSetup':
      return {
        ...state,
        totpSetup: null,
        totpCode: '',
        totpQrCode: null,
        totpQrError: null,
        secretCopied: false,
        mfaError: null,
      }
    case 'setTotpCode':
      return { ...state, totpCode: action.code }
    case 'qrRendered':
      if (state.totpSetup?.otpauthUrl !== action.otpauthUrl) return state
      return {
        ...state,
        totpQrCode: { otpauthUrl: action.otpauthUrl, dataUrl: action.dataUrl },
        totpQrError: null,
      }
    case 'qrFailed':
      if (state.totpSetup?.otpauthUrl !== action.otpauthUrl) return state
      return {
        ...state,
        totpQrError: { otpauthUrl: action.otpauthUrl, message: action.message },
      }
    case 'copySecretSucceeded':
      return { ...state, secretCopied: true }
    case 'setRecoveryCodes':
      return { ...state, recoveryCodes: action.recoveryCodes }
    case 'clearRecoveryCodes':
      return { ...state, recoveryCodes: [] }
    case 'setMfaError':
      return { ...state, mfaError: action.message }
  }
}

async function renderQrCode(
  setup: TotpSetup,
  isCancelled: () => boolean,
  dispatch: Dispatch<MfaAction>,
): Promise<void> {
  try {
    const { renderSVG } = await import('uqr')
    const svg = renderSVG(setup.otpauthUrl, {
      border: 2,
      ecc: 'M',
      blackColor: '#000000',
      whiteColor: '#ffffff',
    })
    if (!isCancelled()) {
      dispatch({
        type: 'qrRendered',
        otpauthUrl: setup.otpauthUrl,
        dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      })
    }
  } catch (err) {
    console.error('[account-security] QR code generation failed:', err)
    if (!isCancelled()) {
      dispatch({
        type: 'qrFailed',
        otpauthUrl: setup.otpauthUrl,
        message: 'Could not render the QR code. Use the setup key instead.',
      })
    }
  }
}

interface TotpSetupDialogProps {
  state: MfaState
  busy: string | null
  totpCodeId: string
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onCopySecret: () => void
  onCodeChange: (code: string) => void
}

function TotpSetupDialog({
  state,
  busy,
  totpCodeId,
  onClose,
  onSubmit,
  onCopySecret,
  onCodeChange,
}: TotpSetupDialogProps) {
  const currentTotpQrDataUrl =
    state.totpSetup && state.totpQrCode?.otpauthUrl === state.totpSetup.otpauthUrl ? state.totpQrCode.dataUrl : null
  const currentTotpQrError =
    state.totpSetup && state.totpQrError?.otpauthUrl === state.totpSetup.otpauthUrl ? state.totpQrError.message : null

  return (
    <Dialog
      open={state.totpSetup !== null}
      onClose={onClose}
      title="Enable two-factor authentication"
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy === 'mfa-enable'}
            onClick={onClose}
          >
            <span>Cancel</span>
          </Button>
          <Button
            type="submit"
            form="security-mfa-form"
            variant="primary"
            size="sm"
            disabled={busy === 'mfa-enable' || state.totpCode.trim().length < 6}
            data-testid="security-mfa-submit"
          >
            <span>{busy === 'mfa-enable' ? 'Enabling...' : 'Enable MFA'}</span>
          </Button>
        </>
      }
    >
      {state.totpSetup && (
        <form id="security-mfa-form" className={styles.dialogFields} onSubmit={onSubmit}>
          <div className={styles.mfaSetupGrid}>
            <div className={styles.qrPanel}>
              <div className={styles.qrFrame} aria-live="polite">
                {currentTotpQrDataUrl ? (
                  <img
                    src={currentTotpQrDataUrl}
                    alt="Scan this QR code with your authenticator app"
                    data-testid="security-mfa-qr-code"
                  />
                ) : (
                  <span className={styles.qrPlaceholder}>
                    {currentTotpQrError ? 'QR code unavailable' : 'Rendering QR code'}
                  </span>
                )}
              </div>
              {currentTotpQrError && <p className={styles.error} role="alert">{currentTotpQrError}</p>}
            </div>

            <div className={styles.mfaSetupContent}>
              <div className={styles.mfaStep}>
                <h3>Scan the QR code</h3>
                <p className={styles.secondaryText}>
                  Use Google Authenticator, 1Password, Microsoft Authenticator, Authy, or any TOTP app.
                </p>
              </div>

              <div className={styles.secretBox}>
                <span className={styles.dialogLabel}>Manual setup key</span>
                <code data-testid="security-mfa-secret">{state.totpSetup.secret}</code>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={onCopySecret}
                  data-testid="security-mfa-copy-secret"
                >
                  <CopySolidIcon size={12} aria-hidden="true" />
                  <span>{state.secretCopied ? 'Copied' : 'Copy key'}</span>
                </Button>
              </div>

              <a className={styles.authenticatorLink} href={state.totpSetup.otpauthUrl}>
                Open authenticator app
              </a>

              <div className={styles.dialogField}>
                <label htmlFor={totpCodeId} className={styles.dialogLabel}>Authentication code</label>
                <Input
                  id={totpCodeId}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={state.totpCode}
                  onChange={(event) => onCodeChange(event.currentTarget.value)}
                  data-testid="security-mfa-code"
                />
              </div>
            </div>
          </div>
          {state.mfaError && <p className={styles.error} role="alert">{state.mfaError}</p>}
        </form>
      )}
    </Dialog>
  )
}

interface RecoveryCodesDialogProps {
  recoveryCodes: string[]
  onClose: () => void
}

function RecoveryCodesDialog({ recoveryCodes, onClose }: RecoveryCodesDialogProps) {
  return (
    <Dialog
      open={recoveryCodes.length > 0}
      onClose={onClose}
      title="Recovery codes"
      size="md"
      footer={
        <Button type="button" variant="primary" size="sm" onClick={onClose}>
          <span>Done</span>
        </Button>
      }
    >
      <div className={styles.dialogFields}>
        <p className={styles.secondaryText}>
          Save these recovery codes now. They will not be shown again.
        </p>
        <div className={styles.recoveryGrid}>
          {recoveryCodes.map((code) => (
            <code key={code}>{code}</code>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

export function MfaSettingsCards({
  user,
  busy,
  runStepUp,
  setSessionUser,
  setBusy,
  setError,
  setStatus,
}: MfaSettingsCardsProps) {
  const [state, dispatch] = useReducer(mfaReducer, initialMfaState)
  const totpCodeId = useId()

  const mfaStatus = user.mfaEnabled
    ? `On${user.mfaEnabledAt ? ` since ${formatDateTime(user.mfaEnabledAt)}` : ''}`
    : 'Off'

  const recoveryStatus = user.mfaEnabled
    ? `${user.mfaRecoveryCodesRemaining} recovery ${user.mfaRecoveryCodesRemaining === 1 ? 'code' : 'codes'} remaining.`
    : 'Enable two-factor authentication before generating recovery codes.'

  useEffect(() => {
    if (!state.totpSetup) return undefined

    const setup = state.totpSetup
    let cancelled = false

    void renderQrCode(setup, () => cancelled, dispatch)
    return () => { cancelled = true }
  }, [state.totpSetup])

  async function handleCopySecret(): Promise<void> {
    if (!state.totpSetup) return
    dispatch({ type: 'setMfaError', message: null })
    if (await copyToClipboard(state.totpSetup.secret)) {
      dispatch({ type: 'copySecretSucceeded' })
      return
    }
    dispatch({ type: 'setMfaError', message: 'Could not copy the setup key.' })
  }

  async function handleStartMfa(): Promise<void> {
    if (busy) return
    setBusy('mfa-start')
    setError(null)
    dispatch({ type: 'setMfaError', message: null })
    setStatus(null)
    try {
      const setup = await runStepUp(() => startCurrentUserTotpSetup())
      dispatch({ type: 'setupStarted', setup })
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        setError(getErrorMessage(err, 'Could not start MFA setup.'))
      }
    } finally {
      setBusy(null)
    }
  }

  async function handleEnableMfa(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const setup = state.totpSetup
    if (busy || !setup) return
    setBusy('mfa-enable')
    dispatch({ type: 'setMfaError', message: null })
    setError(null)
    setStatus(null)
    try {
      const result = await runStepUp(() => enableCurrentUserTotp({ secret: setup.secret, code: state.totpCode }))
      setSessionUser(result.user)
      dispatch({ type: 'resetSetup' })
      dispatch({ type: 'setRecoveryCodes', recoveryCodes: result.recoveryCodes })
      setStatus('Two-factor authentication enabled.')
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        dispatch({ type: 'setMfaError', message: getErrorMessage(err, 'Could not enable MFA.') })
      }
    } finally {
      setBusy(null)
    }
  }

  async function handleDisableMfa(): Promise<void> {
    if (busy) return
    setBusy('mfa-disable')
    setError(null)
    setStatus(null)
    try {
      const updated = await runStepUp(() => disableCurrentUserTotp())
      setSessionUser(updated)
      dispatch({ type: 'clearRecoveryCodes' })
      setStatus('Two-factor authentication disabled.')
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        setError(getErrorMessage(err, 'Could not disable MFA.'))
      }
    } finally {
      setBusy(null)
    }
  }

  async function handleRegenerateRecoveryCodes(): Promise<void> {
    if (busy || !user.mfaEnabled) return
    setBusy('recovery')
    setError(null)
    setStatus(null)
    try {
      const result = await runStepUp(() => regenerateCurrentUserRecoveryCodes())
      setSessionUser(result.user)
      dispatch({ type: 'setRecoveryCodes', recoveryCodes: result.recoveryCodes })
      setStatus('Recovery codes regenerated.')
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        setError(getErrorMessage(err, 'Could not regenerate recovery codes.'))
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SecurityCard
        testId="security-mfa-card"
        title="Two-factor authentication"
        description="Use a TOTP authenticator app as a second factor when signing in."
        status={mfaStatus}
        statusActive={user.mfaEnabled}
        action={
          user.mfaEnabled ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => void handleDisableMfa()}
              data-testid="security-mfa-disable"
            >
              <span>{busy === 'mfa-disable' ? 'Disabling...' : 'Disable'}</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => void handleStartMfa()}
              data-testid="security-mfa-enable"
            >
              <span>{busy === 'mfa-start' ? 'Starting...' : 'Enable'}</span>
            </Button>
          )
        }
      />
      <SecurityCard
        testId="security-recovery-card"
        title="Recovery codes"
        description="One-time codes you can use if you lose access to your authenticator app."
        status={recoveryStatus}
        statusActive={user.mfaEnabled && user.mfaRecoveryCodesRemaining > 0}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy !== null || !user.mfaEnabled}
            onClick={() => void handleRegenerateRecoveryCodes()}
            data-testid="security-recovery-regenerate"
          >
            <span>{busy === 'recovery' ? 'Generating...' : 'Generate codes'}</span>
          </Button>
        }
      />

      <TotpSetupDialog
        state={state}
        busy={busy}
        totpCodeId={totpCodeId}
        onClose={() => dispatch({ type: 'resetSetup' })}
        onSubmit={(event) => void handleEnableMfa(event)}
        onCopySecret={() => void handleCopySecret()}
        onCodeChange={(code) => dispatch({ type: 'setTotpCode', code })}
      />
      <RecoveryCodesDialog
        recoveryCodes={state.recoveryCodes}
        onClose={() => dispatch({ type: 'clearRecoveryCodes' })}
      />
    </>
  )
}
