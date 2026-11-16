/**
 * EmailSection — the SMTP account the site sends its own email through
 * (account emails, test messages), plus a test send and the delivery log.
 *
 * Unlike the other sections this is not part of the site document: it is
 * installation-wide, server-only state behind `mail.manage`, loaded and saved
 * through `/admin/api/cms/mail/*`. The password is write-only — the server
 * never returns it, so an untouched password field keeps the saved one.
 */
import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { pushToast } from '@ui/components/Toast'
import { MAIL_ADDRESS_PATTERN, type MailOutboxEntry, type MailSettingsView } from '@core/mail'
import {
  deleteCmsMailSettings,
  getCmsMailSettings,
  listCmsMailOutbox,
  saveCmsMailSettings,
  sendCmsTestMail,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import s from '../SettingsModal.module.css'
import e from './EmailSection.module.css'

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)
const HOST_RE = /^[a-zA-Z0-9.-]+$/

interface AccountForm {
  host: string
  port: string
  username: string
  password: string
  fromAddress: string
  fromName: string
}

const EMPTY_FORM: AccountForm = {
  host: '',
  port: '587',
  username: '',
  password: '',
  fromAddress: '',
  fromName: '',
}

function formFromSettings(settings: MailSettingsView): AccountForm {
  const account = settings.account
  if (!account) return EMPTY_FORM
  return {
    host: account.host,
    port: String(account.port),
    username: account.username,
    password: '',
    fromAddress: account.fromAddress,
    fromName: account.fromName,
  }
}

/** The first thing stopping a save, or null when the form can be saved. */
function formProblem(form: AccountForm): string | null {
  if (!form.host.trim()) return 'Enter the SMTP host.'
  if (!HOST_RE.test(form.host.trim())) return 'The host is a server name such as smtp.example.com.'
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Enter a port between 1 and 65535.'
  if (!ADDRESS_RE.test(form.fromAddress.trim())) return 'Enter the address emails are sent from.'
  return null
}

function isCancelledStepUp(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

export function EmailSection() {
  const user = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const { data, error, refresh } = useAsyncResource(
    (signal) => getCmsMailSettings(signal),
    [],
    { fallbackError: 'Could not load the email settings' },
  )
  const outbox = useAsyncResource((signal) => listCmsMailOutbox(signal), [], {
    fallbackError: 'Could not load the delivery log',
  })

  // Saves return the fresh view; keep it locally so the form does not flash
  // back through a reload. Render-time seeding, keyed on the loaded reference.
  const [settings, setSettings] = useState<MailSettingsView | null>(null)
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM)
  const [seededFrom, setSeededFrom] = useState<MailSettingsView | null>(null)
  if (data && data !== seededFrom) {
    setSeededFrom(data)
    setSettings(data)
    setForm(formFromSettings(data))
  }

  const [busy, setBusy] = useState<'save' | 'remove' | 'test' | null>(null)
  const [testTo, setTestTo] = useState(user?.email ?? '')

  if (error) return <p className={s.sectionDescription} role="alert">{error}</p>
  if (!settings) return <SkeletonBlock minHeight={320} ariaLabel="Loading email settings" />

  const account = settings.account
  const saved = formFromSettings(settings)
  const dirty =
    form.password !== '' ||
    (Object.keys(saved) as Array<keyof AccountForm>).some((key) => form[key] !== saved[key])
  const problem = formProblem(form)
  const saveHint = problem ?? (dirty ? null : account ? 'No changes to save.' : null)

  function applySaved(next: MailSettingsView) {
    setSettings(next)
    setForm(formFromSettings(next))
    outbox.refresh()
  }

  function setField(key: keyof AccountForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleSave() {
    setBusy('save')
    try {
      const next = await runStepUp(() =>
        saveCmsMailSettings({
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username.trim(),
          // Untouched means "keep the saved password"; the server never sent it back.
          ...(form.password !== '' ? { password: form.password } : {}),
          fromAddress: form.fromAddress.trim(),
          fromName: form.fromName.trim(),
        }),
      )
      applySaved(next)
      pushToast({ kind: 'success', title: 'Email account saved', body: 'Send a test email to check it works.' })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[EmailSection] save failed:', err)
      pushToast({ kind: 'error', title: 'Could not save the email account', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(null)
    }
  }

  async function handleRemove() {
    setBusy('remove')
    try {
      applySaved(await runStepUp(() => deleteCmsMailSettings()))
      pushToast({ kind: 'success', title: 'Email account removed' })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[EmailSection] remove failed:', err)
      pushToast({ kind: 'error', title: 'Could not remove the email account', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(null)
    }
  }

  async function handleTest() {
    setBusy('test')
    try {
      const status = await sendCmsTestMail(testTo.trim())
      pushToast(
        status === 'captured'
          ? { kind: 'success', title: 'Test email captured', body: 'It is in the delivery log below. Nothing was sent.' }
          : { kind: 'success', title: 'Test email sent', body: `Check the inbox of ${testTo.trim()}.` },
      )
    } catch (err) {
      console.error('[EmailSection] test send failed:', err)
      pushToast({ kind: 'error', title: 'The test email was not sent', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setBusy(null)
      outbox.refresh()
      refresh()
    }
  }

  const testProblem =
    settings.mode === 'off'
      ? 'Save an SMTP account first.'
      : dirty
        ? 'Save your changes first.'
        : ADDRESS_RE.test(testTo.trim())
          ? null
          : 'Enter the address to send the test to.'

  return (
    <div>
      <p className={s.sectionDescription}>
        The account this site sends its own email through: sign-up confirmations, password resets
        and sign-in links.
      </p>

      <DeliveryStatus settings={settings} />

      <section aria-labelledby="email-account-heading" className={s.sectionBlock}>
        <h4 id="email-account-heading" className={s.subHeading}>SMTP account</h4>

        <div className={e.form}>
          <label htmlFor="email-host" className={e.fieldLabel}>Host</label>
          <Input
            id="email-host"
            type="text"
            value={form.host}
            placeholder="smtp.example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setField('host', event.target.value)}
          />

          <label htmlFor="email-port" className={e.fieldLabel}>Port</label>
          <div>
            <Input
              id="email-port"
              type="text"
              inputMode="numeric"
              value={form.port}
              className={e.portInput}
              aria-describedby="email-port-hint"
              onChange={(event) => setField('port', event.target.value)}
            />
            <p id="email-port-hint" className={e.fieldHint}>
              465 connects over TLS. Any other port must upgrade with STARTTLS before signing in.
            </p>
          </div>

          <label htmlFor="email-username" className={e.fieldLabel}>Username</label>
          <Input
            id="email-username"
            type="text"
            value={form.username}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setField('username', event.target.value)}
          />

          <label htmlFor="email-password" className={e.fieldLabel}>Password</label>
          <div>
            <Input
              id="email-password"
              type="password"
              value={form.password}
              autoComplete="new-password"
              placeholder={account?.hasPassword ? 'Saved. Type to replace it' : ''}
              aria-describedby="email-password-hint"
              onChange={(event) => setField('password', event.target.value)}
            />
            <p id="email-password-hint" className={e.fieldHint}>
              Stored encrypted on the server and never shown again.
            </p>
          </div>

          <label htmlFor="email-from-name" className={e.fieldLabel}>Sender name</label>
          <Input
            id="email-from-name"
            type="text"
            value={form.fromName}
            placeholder="My Website"
            onChange={(event) => setField('fromName', event.target.value)}
          />

          <label htmlFor="email-from-address" className={e.fieldLabel}>Sender address</label>
          <Input
            id="email-from-address"
            type="email"
            value={form.fromAddress}
            placeholder="hello@example.com"
            autoComplete="off"
            onChange={(event) => setField('fromAddress', event.target.value)}
          />
        </div>

        <div className={e.actions}>
          <Button
            variant="primary"
            size="md"
            onClick={handleSave}
            disabled={saveHint !== null || busy !== null}
            busy={busy === 'save'}
            aria-describedby={saveHint ? 'email-save-hint' : undefined}
          >
            {account ? 'Save changes' : 'Save account'}
          </Button>
          {account && (
            <Button
              variant="ghost"
              size="md"
              tone="danger"
              onClick={handleRemove}
              disabled={busy !== null}
              busy={busy === 'remove'}
            >
              Remove account
            </Button>
          )}
          {saveHint && <p id="email-save-hint" className={e.actionHint}>{saveHint}</p>}
        </div>
      </section>

      <section aria-labelledby="email-test-heading" className={s.sectionBlock}>
        <h4 id="email-test-heading" className={s.subHeading}>Send a test</h4>
        <div className={e.testRow}>
          <label htmlFor="email-test-to" className={s.srOnly}>Send the test email to</label>
          <Input
            id="email-test-to"
            type="email"
            value={testTo}
            placeholder="you@example.com"
            onChange={(event) => setTestTo(event.target.value)}
          />
          <Button
            variant="secondary"
            size="md"
            onClick={handleTest}
            disabled={testProblem !== null || busy !== null}
            busy={busy === 'test'}
            aria-describedby={testProblem ? 'email-test-hint' : undefined}
          >
            Send test email
          </Button>
        </div>
        {testProblem && <p id="email-test-hint" className={e.fieldHint}>{testProblem}</p>}
      </section>

      <section aria-labelledby="email-log-heading" className={s.sectionBlock}>
        <h4 id="email-log-heading" className={s.subHeading}>Delivery log</h4>
        <DeliveryLog entries={outbox.data} error={outbox.error} />
      </section>
    </div>
  )
}

function DeliveryStatus({ settings }: { settings: MailSettingsView }) {
  const account = settings.account
  return (
    <div className={e.status}>
      <div className={e.statusTile} data-mode={settings.mode}>
        <span className={e.statusDot} aria-hidden="true" />
        <div>
          <p className={e.statusTitle}>
            {settings.mode === 'smtp' && account && `Sending through ${account.host}`}
            {settings.mode === 'capture' && 'Development mode: emails are captured, not sent'}
            {settings.mode === 'off' && 'Email is not set up'}
          </p>
          <p className={e.statusBody}>
            {settings.mode === 'smtp' && account && `From ${account.fromAddress}, port ${account.port}.`}
            {settings.mode === 'capture' &&
              'With no account saved, this development server writes each email to the delivery log below so you can read it and follow its links.'}
            {settings.mode === 'off' &&
              'Until an account is saved, the site cannot send confirmations, password resets or sign-in links.'}
          </p>
        </div>
      </div>

      {account?.passwordNeedsReentry && (
        <Alert tone="warning" title="Enter the SMTP password again">
          The server secret key changed, so the saved password can no longer be read. Type it in
          and save.
        </Alert>
      )}
      {!settings.publicOrigin && (
        <Alert tone="warning" title="The site's public address is not set">
          Links in emails are built from the <code>PUBLIC_ORIGIN</code> setting on the server.
          Set it to the address visitors use (for example <code>https://example.com</code>) so
          those links point at your site.
        </Alert>
      )}
    </div>
  )
}

const STATUS_LABEL: Record<MailOutboxEntry['status'], string> = {
  sent: 'Sent',
  failed: 'Failed',
  captured: 'Captured',
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function DeliveryLog({ entries, error }: { entries: MailOutboxEntry[] | null; error: string | null }) {
  if (error) return <p className={e.fieldHint} role="alert">{error}</p>
  if (!entries) return <SkeletonBlock minHeight={80} ariaLabel="Loading the delivery log" />
  if (entries.length === 0) {
    return <p className={e.logEmpty}>No email has been sent yet.</p>
  }
  return (
    <ul className={e.log}>
      {entries.map((entry) => (
        <li key={entry.id} className={e.logRow}>
          <div className={e.logHead}>
            <span className={e.logStatus} data-status={entry.status}>{STATUS_LABEL[entry.status]}</span>
            <span className={e.logSubject}>{entry.subject}</span>
            <span className={e.logMeta}>{entry.to}</span>
            <time className={e.logMeta} dateTime={entry.createdAt}>{formatWhen(entry.createdAt)}</time>
          </div>
          {entry.error && <p className={e.logError}>{entry.error}</p>}
          {entry.body && (
            <details className={e.logBody}>
              <summary>Read the message</summary>
              <pre>{entry.body}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}
