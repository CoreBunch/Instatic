/**
 * The "add a connector" panel: one form per connector kind.
 *
 * One-key providers ask for a name and an API key (Mailgun also for its
 * sending domain). SMTP starts from a picker of well-known services that
 * fills in the server, so most owners only type their login.
 */
import { useId, useState } from 'react'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import type { MailConnector, MailConnectorInput } from '@core/mail'
import { createCmsMailConnector } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ConnectorGlyph, ConnectorMark } from '../ConnectorMark'
import { looksLikeLocalMailHost, SMTP_PRESETS, type ConnectorSpec, type SmtpPreset } from '../connectorCatalog'
import styles from '../EmailPage.module.css'

const MAILGUN_REGIONS = [
  { value: 'us', label: 'US (api.mailgun.net)' },
  { value: 'eu', label: 'EU (api.eu.mailgun.net)' },
]

/** Password managers must not offer to save or fill a provider secret. */
const SECRET_INPUT_PROPS = {
  type: 'password',
  autoComplete: 'new-password',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-form-type': 'other',
} as const

export function ConnectorSetupPanel({
  spec,
  privateHostsAllowed,
  onCreated,
}: {
  spec: ConnectorSpec
  privateHostsAllowed: boolean
  onCreated: (connector: MailConnector) => void
}) {
  return (
    <article className={ws.providerSetup} aria-labelledby="connector-setup-title">
      <header className={ws.providerSetupHeader}>
        <ConnectorMark logo={spec.logo} size="lg" />
        <div>
          <span className={ws.detailEyebrow}>Add connector</span>
          <h2 id="connector-setup-title">Connect {spec.label}</h2>
          <p>{spec.description}</p>
        </div>
      </header>

      <section className={ws.providerSetupFormSection}>
        <div className={ws.detailSectionHeader}>
          <div>
            <h3>Connection details</h3>
            <p>The {spec.secretName} is encrypted before it is stored and never shown again.</p>
          </div>
        </div>
        <AddConnectorForm spec={spec} privateHostsAllowed={privateHostsAllowed} onCreated={onCreated} />
      </section>
    </article>
  )
}

function AddConnectorForm({
  spec,
  privateHostsAllowed,
  onCreated,
}: {
  spec: ConnectorSpec
  privateHostsAllowed: boolean
  onCreated: (connector: MailConnector) => void
}) {
  const { runStepUp } = useStepUp()
  const ids = {
    label: useId(), host: useId(), port: useId(), username: useId(), region: useId(), key: useId(),
    domain: useId(), mailgunRegion: useId(), secret: useId(), presets: useId(),
  }
  // The name starts as the service's own, so a one-key connector is one field to fill.
  const [label, setLabel] = useState(spec.kind === 'smtp' ? '' : spec.label)
  const [labelEdited, setLabelEdited] = useState(false)
  const [preset, setPreset] = useState<SmtpPreset | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [username, setUsername] = useState('')
  const [region, setRegion] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [domain, setDomain] = useState('')
  const [mailgunRegion, setMailgunRegion] = useState<'us' | 'eu'>('us')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  function pickPreset(next: SmtpPreset | null) {
    setPreset(next)
    setHost(next?.host ?? '')
    setPort(String(next?.port ?? 587))
    setUsername(next?.username ?? '')
    if (!labelEdited) setLabel(next?.label ?? '')
  }

  function buildInput(): MailConnectorInput {
    const name = label.trim()
    switch (spec.kind) {
      case 'smtp':
        return { kind: 'smtp', label: name, config: { host: host.trim(), port: Number(port), username: username.trim() }, secret }
      case 'ses':
        return { kind: 'ses', label: name, config: { region: region.trim(), accessKeyId: accessKeyId.trim() }, secret }
      case 'mailgun':
        return { kind: 'mailgun', label: name, config: { domain: domain.trim(), region: mailgunRegion }, secret: secret.trim() }
      default:
        return { kind: spec.kind, label: name, config: {}, secret: secret.trim() }
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const connector = await runStepUp(() => createCmsMailConnector(buildInput()))
      onCreated(connector)
      pushToast({ kind: 'success', title: `${spec.label} connected`, body: 'Send a test email to check it works.' })
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      console.error('[ConnectorSetup] create failed:', err)
      pushToast({ kind: 'error', title: `Could not connect ${spec.label}`, body: getErrorMessage(err, 'Check the details and try again.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={ws.providerSetupForm} onSubmit={(event) => void handleSubmit(event)}>
      {spec.kind === 'smtp' && (
        <div className={ws.providerSetupField}>
          <label id={ids.presets}>Mail service</label>
          <div>
            <div className={styles.presetRow} role="group" aria-labelledby={ids.presets}>
              {SMTP_PRESETS.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant="secondary"
                  size="md"
                  active={preset?.id === option.id}
                  aria-pressed={preset?.id === option.id}
                  className={styles.presetButton}
                  onClick={() => pickPreset(option)}
                >
                  <ConnectorGlyph logo={option.logo} />
                  <span>{option.label}</span>
                </Button>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="md"
                active={preset === null}
                aria-pressed={preset === null}
                className={styles.presetButton}
                onClick={() => pickPreset(null)}
              >
                <ConnectorGlyph logo={null} />
                <span>Other server</span>
              </Button>
            </div>
            <p>{preset ? `Fills in ${preset.label}'s server below. You only add your login.` : 'Pick a service to fill in its server, or enter your own.'}</p>
          </div>
        </div>
      )}

      <div className={ws.providerSetupField}>
        <label htmlFor={ids.label}>Display label</label>
        <div>
          <Input
            id={ids.label}
            value={label}
            onChange={(event) => { setLabel(event.currentTarget.value); setLabelEdited(true) }}
            placeholder={`e.g. ${spec.label} production`}
            required
          />
          <p>A name teammates will recognise.</p>
        </div>
      </div>

      {spec.kind === 'smtp' && (
        <>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.host}>Host</label>
            <div>
              <Input id={ids.host} value={host} onChange={(event) => setHost(event.currentTarget.value)} placeholder="smtp.example.com" pattern="[a-zA-Z0-9.\-]+" spellCheck={false} required />
              <p>
                {!looksLikeLocalMailHost(host)
                  ? 'The mail server’s name, for example smtp.example.com.'
                  : privateHostsAllowed
                    ? 'A relay on this machine or network. This server allows those.'
                    : 'This looks like a relay on this machine or network. The server only connects to one when it runs with MAIL_ALLOW_PRIVATE_HOSTS=1.'}
              </p>
            </div>
          </div>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.port}>Port</label>
            <div>
              <Input id={ids.port} value={port} onChange={(event) => setPort(event.currentTarget.value)} inputMode="numeric" pattern="[0-9]{1,5}" required />
              <p>465 connects over TLS. Any other port must upgrade with STARTTLS before signing in.</p>
            </div>
          </div>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.username}>Username{!preset && <span>Optional</span>}</label>
            <div>
              <Input id={ids.username} value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="off" spellCheck={false} required={preset !== null} />
              {preset && <p>{preset.usernameHint}</p>}
            </div>
          </div>
        </>
      )}

      {spec.kind === 'ses' && (
        <>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.region}>Region</label>
            <div>
              <Input id={ids.region} value={region} onChange={(event) => setRegion(event.currentTarget.value)} placeholder="eu-central-1" pattern="[a-z]{2}(-[a-z]+)+-[0-9]" spellCheck={false} required />
              <p>The AWS region where your sender address or domain is verified.</p>
            </div>
          </div>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.key}>Access key ID</label>
            <div>
              <Input id={ids.key} value={accessKeyId} onChange={(event) => setAccessKeyId(event.currentTarget.value)} placeholder="AKIA…" pattern="[A-Z0-9]{16,128}" autoComplete="off" spellCheck={false} required />
              <p>Of an IAM user or role allowed to call ses:SendEmail.</p>
            </div>
          </div>
        </>
      )}

      {spec.kind === 'mailgun' && (
        <>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.domain}>Sending domain</label>
            <div>
              <Input id={ids.domain} value={domain} onChange={(event) => setDomain(event.currentTarget.value)} placeholder="mg.example.com" pattern="[a-zA-Z0-9]([a-zA-Z0-9.\-]*[a-zA-Z0-9])?" spellCheck={false} required />
              <p>The domain you added and verified in Mailgun.</p>
            </div>
          </div>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.mailgunRegion}>Region</label>
            <div>
              <Select
                id={ids.mailgunRegion}
                value={mailgunRegion}
                options={MAILGUN_REGIONS}
                onChange={(event) => setMailgunRegion(event.currentTarget.value === 'eu' ? 'eu' : 'us')}
              />
              <p>Where the Mailgun account keeps this domain.</p>
            </div>
          </div>
        </>
      )}

      <div className={ws.providerSetupField}>
        <label htmlFor={ids.secret}>
          {spec.secretLabel}
          {spec.kind === 'smtp' && !preset && <span>Optional</span>}
        </label>
        <div>
          <Input
            id={ids.secret}
            value={secret}
            onChange={(event) => setSecret(event.currentTarget.value)}
            required={spec.kind !== 'smtp' || preset !== null}
            {...SECRET_INPUT_PROPS}
          />
          <p>{spec.kind === 'smtp' && preset ? preset.passwordHint : spec.secretHint}</p>
        </div>
      </div>

      <div className={ws.providerSetupActions}>
        <Button type="submit" variant="primary" size="md" busy={busy}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Connect {spec.kind === 'smtp' && preset ? preset.label : spec.label}</span>
        </Button>
      </div>
    </form>
  )
}
