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
import { LanguageSwitcher, useI18n, type MessageKey } from '../i18n'

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
  title: MessageKey
  submit: MessageKey
  submitPending: MessageKey
}

const PHASE_COPY: Record<PreAuthPhase, PhaseCopy> = {
  setup: {
    title: 'preauth.setup.title',
    submit: 'preauth.setup.submit',
    submitPending: 'preauth.setup.submitPending',
  },
  login: {
    title: 'preauth.login.title',
    submit: 'preauth.login.submit',
    submitPending: 'preauth.login.submitPending',
  },
  mfa: {
    title: 'preauth.mfa.title',
    submit: 'preauth.mfa.submit',
    submitPending: 'preauth.mfa.submitPending',
  },
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
  const { t } = useI18n()
  const [siteName, setSiteName] = useState(() => t('preauth.setup.defaultSiteName'))
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
      setError(t('preauth.error.passwordTooShort', { min: MIN_PASSWORD_LENGTH }))
      return
    }
    await runAuthAction(async () => {
      await setupCms({ siteName, email, password, displayName })
      await loginCms({ email, password })
      onAuthenticated(await getCurrentCmsUser())
    }, t('preauth.error.setupFailed'), setSubmitting, setError)
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
    }, t('preauth.error.loginFailed'), setSubmitting, setError)
  }

  async function handleMfaVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAuthAction(async () => {
      await verifyCmsMfa({ code: mfaCode })
      const user = await getCurrentCmsUser()
      setMfaCode('')
      onAuthenticated(user)
    }, t('preauth.error.mfaVerificationFailed'), setSubmitting, setError)
  }

  const copy = PHASE_COPY[phase]
  const submitLabel = t(submitting ? copy.submitPending : copy.submit)

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
        <div className={styles.headerRow}>
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
          <LanguageSwitcher className={styles.languageSwitcher} />
        </div>

        <h1 id="admin-entry-title" className={panelStyles.title}>{t(copy.title)}</h1>

        <form className={styles.form} onSubmit={onSubmit}>
          {phase === 'mfa' ? (
            <label className={styles.field} htmlFor={mfaCodeId}>
              <span>{t('preauth.field.authenticationCode')}</span>
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
                <span>{t('preauth.field.siteName')}</span>
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
                <span>
                  {t('preauth.field.displayName')}{' '}
                  <span className={styles.hint}>{t('preauth.field.displayNameHint')}</span>
                </span>
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
                <span>{t('preauth.field.email')}</span>
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
                <span>{t('preauth.field.password')}</span>
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
