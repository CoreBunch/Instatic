import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import {
  getCurrentCmsUser,
  loginCms,
  setupCms,
  verifyCmsMfa,
  type CmsCurrentUser,
  type CmsPublicSite,
} from '@core/persistence/auth'
import panelStyles from '../AdminEntry.module.css'
import styles from './AdminPreAuthForm.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

// Phase the unauthenticated form can be in. 'mfa' is a sub-state reached
// only after a login submit returns `mfaRequired: true` — never set by the
// boot hook directly.
export type PreAuthPhase = 'setup' | 'login' | 'mfa'

interface AdminPreAuthFormProps {
  phase: PreAuthPhase
  publicSite: CmsPublicSite
  initialError: string | null
  onPhaseChange: (phase: PreAuthPhase) => void
  onAuthenticated: (user: CmsCurrentUser) => void
}

interface PhaseCopy {
  title: string
  submit: string
  submitPending: string
}

const PHASE_COPY: Record<PreAuthPhase, PhaseCopy> = {
  setup: { title: 'Set Up CMS', submit: 'Create Admin', submitPending: 'Setting up' },
  login: { title: 'Admin Login', submit: 'Sign In', submitPending: 'Signing in' },
  mfa: { title: 'Two-Factor Authentication', submit: 'Verify', submitPending: 'Verifying' },
}

const MIN_PASSWORD_LENGTH = 12

async function runAuthAction(
  action: () => Promise<void>,
  fallbackMessage: string,
  setSubmitting: (v: boolean) => void,
  setError: (v: string | null) => void,
): Promise<void> {
  setSubmitting(true)
  setError(null)
  try {
    await action()
  } catch (err) {
    setError(getErrorMessage(err, fallbackMessage))
  } finally {
    setSubmitting(false)
  }
}

export function AdminPreAuthForm({
  phase,
  publicSite,
  initialError,
  onPhaseChange,
  onAuthenticated,
}: AdminPreAuthFormProps) {
  const [siteName, setSiteName] = useState('My Site')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(initialError)

  const siteNameId = useId()
  const displayNameId = useId()
  const emailId = useId()
  const passwordId = useId()
  const mfaCodeId = useId()

  async function handleSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      return
    }
    await runAuthAction(async () => {
      await setupCms({ siteName, email, password, displayName })
      await loginCms({ email, password })
      onAuthenticated(await getCurrentCmsUser())
    }, 'Setup failed', setSubmitting, setError)
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAuthAction(async () => {
      const result = await loginCms({ email, password })
      if (result.mfaRequired) {
        setPassword('')
        setMfaCode('')
        onPhaseChange('mfa')
        return
      }
      onAuthenticated(await getCurrentCmsUser())
    }, 'Login failed', setSubmitting, setError)
  }

  async function handleMfaVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAuthAction(async () => {
      await verifyCmsMfa({ code: mfaCode })
      const user = await getCurrentCmsUser()
      setMfaCode('')
      onAuthenticated(user)
    }, 'MFA verification failed', setSubmitting, setError)
  }

  const copy = PHASE_COPY[phase]
  const submitLabel = submitting ? copy.submitPending : copy.submit

  // Pre-auth brand row: when the install has picked a favicon, render it
  // in place of the default icon AND swap the "Instatic" label for
  // the operator-configured site name. When neither is set, keep the
  // default mark + product name so a fresh clone still looks like itself.
  const brandLabel = publicSite.name ?? 'Instatic'

  const onSubmit =
    phase === 'setup' ? handleSetup :
    phase === 'mfa' ? handleMfaVerify :
    handleLogin

  return (
    <main className={panelStyles.page}>
      <section className={panelStyles.panel} aria-labelledby="admin-entry-title">
        <div className={styles.brandRow}>
          {publicSite.faviconUrl ? (
            <img
              className={styles.brandFavicon}
              src={publicSite.faviconUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          ) : (
            <div className={styles.brandIcon} aria-hidden="true">
              <DatabaseSolidIcon size={16} />
            </div>
          )}
          <span>{brandLabel}</span>
        </div>

        <h1 id="admin-entry-title" className={panelStyles.title}>{copy.title}</h1>

        <form className={styles.form} onSubmit={onSubmit}>
          {phase === 'mfa' ? (
            <label className={styles.field} htmlFor={mfaCodeId}>
              <span>Authentication code</span>
              <Input
                id={mfaCodeId}
                value={mfaCode}
                onChange={(event) => setMfaCode(event.target.value)}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                data-testid="admin-mfa-code"
              />
            </label>
          ) : phase === 'setup' && (
            <>
              <label className={styles.field} htmlFor={siteNameId}>
                <span>Site name</span>
                <Input
                  id={siteNameId}
                  value={siteName}
                  onChange={(event) => setSiteName(event.target.value)}
                  required
                  autoComplete="organization"
                />
              </label>

              {/* Optional, and public: this is what author bindings render on
                  published pages. Left blank they render nothing — which is
                  why it is offered here rather than only on the account page. */}
              <label className={styles.field} htmlFor={displayNameId}>
                <span>Your name <span className={styles.hint}>optional, shown on published pages</span></span>
                <Input
                  id={displayNameId}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  data-testid="admin-setup-display-name"
                />
              </label>
            </>
          )}

          {phase !== 'mfa' && (
            <>
              <label className={styles.field} htmlFor={emailId}>
                <span>Email</span>
                <Input
                  id={emailId}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  autoComplete="email"
                />
              </label>

              <label className={styles.field} htmlFor={passwordId}>
                <span>Password</span>
                <Input
                  id={passwordId}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={phase === 'setup' ? MIN_PASSWORD_LENGTH : undefined}
                  type="password"
                  autoComplete={phase === 'setup' ? 'new-password' : 'current-password'}
                />
              </label>
            </>
          )}

          {error && (
            <p role="alert" className={panelStyles.error}>
              {error}
            </p>
          )}

          <Button
            variant="primary"
            size="md"
            type="submit"
            fullWidth
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting && (
              <LoaderIcon size={14} className={styles.spinIcon} aria-hidden="true" />
            )}
            <span>{submitLabel}</span>
          </Button>
        </form>
      </section>
    </main>
  )
}
