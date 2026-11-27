/** Defaults: which connector the site sends through, and who its email is from. */
import { Alert } from '@ui/components/Alert'
import { useId, useState } from 'react'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { WorkspaceSection } from '@admin/shared/SettingsWorkspace/WorkspaceSection'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { MAIL_ADDRESS_PATTERN, type MailDefaults, type MailOverview } from '@core/mail'
import { saveCmsMailDefaults } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { connectorEndpoint } from '../connectorCatalog'
import styles from '../EmailPage.module.css'

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

const MODE_COPY: Record<MailOverview['mode'], { title: string; body: string }> = {
  send: {
    title: 'Email is being sent',
    body: 'Outgoing email uses the saved connector and sender address.',
  },
  capture: {
    title: 'Development mode: emails are captured, not sent',
    body: 'Until a connector and a sender address are set, this development server writes each email to Activity so you can read it and follow its links.',
  },
  off: {
    title: 'Email is not set up',
    body: 'Until a connector and a sender address are set, the site cannot send confirmations, password resets or sign-in links.',
  },
}

/** The first thing stopping a save, or null. */
function problem(form: MailDefaults): string | null {
  if (form.fromAddress !== '' && !ADDRESS_RE.test(form.fromAddress)) return 'The sender address is not a valid email address.'
  if (form.replyTo !== '' && !ADDRESS_RE.test(form.replyTo)) return 'The reply-to address is not a valid email address.'
  return null
}

export function DefaultsTab({
  overview,
  error,
  onChanged,
  onNavigateToConnectors,
}: {
  overview: MailOverview | null
  error: string | null
  onChanged: () => void
  onNavigateToConnectors: () => void
}) {
  const { runStepUp } = useStepUp()
  const ids = { connector: useId(), name: useId(), address: useId(), reply: useId() }
  const [form, setForm] = useState<MailDefaults | null>(null)
  const [seededFrom, setSeededFrom] = useState<MailDefaults | null>(null)
  if (overview && overview.defaults !== seededFrom) {
    setSeededFrom(overview.defaults)
    setForm(overview.defaults)
  }
  const [saving, setSaving] = useState(false)

  if (error) return <Alert tone="danger">{error}</Alert>
  if (!overview || !form) return <div className={ws.emptyState}>Loading…</div>

  const saved = overview.defaults
  const dirty = (Object.keys(saved) as Array<keyof MailDefaults>).some((key) => form[key] !== saved[key])
  const invalid = problem(form)
  const mode = MODE_COPY[overview.mode]

  function set<K extends keyof MailDefaults>(key: K, value: MailDefaults[K]) {
    setForm((current) => (current ? { ...current, [key]: value } : current))
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (!form) return
    setSaving(true)
    try {
      await runStepUp(() => saveCmsMailDefaults({
        ...form,
        fromAddress: form.fromAddress.trim(),
        fromName: form.fromName.trim(),
        replyTo: form.replyTo.trim(),
      }))
      onChanged()
      pushToast({ kind: 'success', title: 'Email defaults saved' })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[DefaultsTab] save failed:', err)
      pushToast({ kind: 'error', title: 'Could not save the defaults', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <WorkspaceSection title="Defaults">
      <div className={styles.defaultsLayout}>
        {overview.connectors.length === 0 ? (
          <div className={styles.defaultsEmpty}>
            <h2>Add a connector first</h2>
            <p>Connect an email service to choose a sender address.</p>
            <Button type="button" variant="primary" size="md" onClick={onNavigateToConnectors}>
              <span>Add a connector</span>
              <ArrowRightIcon size={13} aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <form className={styles.defaultsForm} onSubmit={(event) => void handleSave(event)}>
            <div className={ws.providerSetupField}>
              <label htmlFor={ids.connector}>Send through</label>
              <div>
                <Select
                  id={ids.connector}
                  value={form.defaultConnectorId ?? ''}
                  onChange={(event) => set('defaultConnectorId', event.currentTarget.value || null)}
                >
                  <option value="">No connector (email is not sent)</option>
                  {overview.connectors.map((connector) => (
                    <option key={connector.id} value={connector.id}>
                      {connector.label} ({connectorEndpoint(connector)})
                    </option>
                  ))}
                </Select>
                <p>Every email the site sends goes through this connector.</p>
              </div>
            </div>

            <div className={ws.providerSetupField}>
              <label htmlFor={ids.name}>Sender name<span>Optional</span></label>
              <div>
                <Input id={ids.name} value={form.fromName} onChange={(event) => set('fromName', event.currentTarget.value)} placeholder="My Website" />
                <p>Shown before the address in the recipient’s inbox.</p>
              </div>
            </div>

            <div className={ws.providerSetupField}>
              <label htmlFor={ids.address}>Sender address</label>
              <div>
                <Input id={ids.address} type="email" value={form.fromAddress} onChange={(event) => set('fromAddress', event.currentTarget.value)} placeholder="hello@example.com" autoComplete="off" />
                <p>The address email comes from. The connector’s provider must be allowed to send as it.</p>
              </div>
            </div>

            <div className={ws.providerSetupField}>
              <label htmlFor={ids.reply}>Reply-to<span>Optional</span></label>
              <div>
                <Input id={ids.reply} type="email" value={form.replyTo} onChange={(event) => set('replyTo', event.currentTarget.value)} placeholder="support@example.com" autoComplete="off" />
                <p>Where replies go, when that is not the sender address.</p>
              </div>
            </div>

            <div className={styles.defaultsActions}>
              {invalid && <span role="alert" className={styles.warning}>{invalid}</span>}
              <Button type="submit" variant="primary" size="md" disabled={!dirty || invalid !== null} busy={saving}>
                Save defaults
              </Button>
            </div>
          </form>
        )}
        <aside className={styles.deliveryStatus} aria-label="Delivery status">
          <div className={styles.modeTile} data-mode={overview.mode} role="status">
            <span className={styles.modeDot} aria-hidden="true" />
            <div>
              <p className={styles.modeTitle}>{mode.title}</p>
              <p className={styles.modeBody}>{mode.body}</p>
            </div>
          </div>

          {!overview.publicOrigin && (
            <Alert tone="warning" role="status">
              <strong>The site’s public address is not set.</strong> Links in emails are built from the{' '}
              <code>PUBLIC_ORIGIN</code> setting on the server. Set it to the address visitors use (for example{' '}
              <code>https://example.com</code>) so those links point at your site.
            </Alert>
          )}
        </aside>
      </div>
    </WorkspaceSection>
  )
}
