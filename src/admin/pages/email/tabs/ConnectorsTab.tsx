/** Connectors in the shared master-detail workspace: the accounts mail is sent through. */
import { useId, useState } from 'react'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { SettingsListSection } from '@admin/shared/SettingsWorkspace/SettingsListSection'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import {
  MAIL_ADDRESS_PATTERN,
  type MailConnector,
  type MailConnectorInput,
  type MailConnectorKind,
  type MailOverview,
} from '@core/mail'
import {
  createCmsMailConnector,
  deleteCmsMailConnector,
  setCmsMailConnectorSecret,
  testCmsMailConnector,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ConnectorMark } from '../ConnectorMark'
import { CONNECTOR_SPECS, getConnectorSpec, type ConnectorSpec } from '../connectorCatalog'
import styles from '../EmailPage.module.css'

const ADDRESS_RE = new RegExp(MAIL_ADDRESS_PATTERN)

type Selection = { kind: 'connector'; id: string } | { kind: 'add'; connectorKind: MailConnectorKind }

function isCancelledStepUp(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

export function ConnectorsTab({
  overview,
  loading,
  error,
  onChanged,
  onNavigateToDefaults,
}: {
  overview: MailOverview | null
  loading: boolean
  error: string | null
  onChanged: () => void
  onNavigateToDefaults: () => void
}) {
  const { runStepUp } = useStepUp()
  const [selection, setSelection] = useState<Selection | null>(null)
  const [removeCandidate, setRemoveCandidate] = useState<MailConnector | null>(null)
  const [removing, setRemoving] = useState(false)

  const connectors = overview?.connectors ?? []
  const effective: Selection =
    selection ?? (connectors[0] ? { kind: 'connector', id: connectors[0].id } : { kind: 'add', connectorKind: 'smtp' })
  const selected = effective.kind === 'connector'
    ? connectors.find((connector) => connector.id === effective.id)
    : undefined
  // A selected connector that has since been removed falls back to the setup panel.
  const addKind = effective.kind === 'add' ? effective.connectorKind : selected ? null : 'smtp'

  async function handleRemove(connector: MailConnector) {
    setRemoving(true)
    try {
      await runStepUp(() => deleteCmsMailConnector(connector.id))
      setRemoveCandidate(null)
      setSelection(null)
      onChanged()
      pushToast({ kind: 'success', title: `${connector.label} removed` })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[ConnectorsTab] remove failed:', err)
      pushToast({ kind: 'error', title: 'Could not remove the connector', body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section className={ws.settingsWorkspace} aria-labelledby="connectors-heading">
      <aside className={ws.settingsBrowser} aria-label="Connector browser">
        <div className={ws.settingsBrowserHeader}>
          <h2 id="connectors-heading">Connectors</h2>
        </div>

        {error && <p role="alert" className={ws.settingsBrowserError}>{error}</p>}

        <div className={ws.settingsBrowserSections}>
          {(loading || connectors.length > 0) && (
            <SettingsListSection label="Connected">
              {loading && connectors.length === 0 ? (
                <p className={ws.settingsBrowserEmpty}>Loading connectors…</p>
              ) : (
                connectors.map((connector) => {
                  const active = effective.kind === 'connector' && effective.id === connector.id
                  const healthy = !connector.secretNeedsReentry && connector.lastError === null
                  const isDefault = overview?.defaults.defaultConnectorId === connector.id
                  return (
                    <Button
                      key={connector.id}
                      type="button"
                      variant="ghost"
                      size="md"
                      fullWidth
                      active={active}
                      align="start"
                      className={ws.settingsListItem}
                      onClick={() => setSelection({ kind: 'connector', id: connector.id })}
                      aria-current={active ? 'true' : undefined}
                    >
                      <ConnectorMark kind={connector.kind} size="sm" />
                      <span className={ws.settingsListIdentity}>
                        <span className={ws.settingsListLabel}>{connector.label}</span>
                        <span className={ws.settingsListMeta}>
                          <span className={healthy ? ws.healthDot : ws.warningDot} />
                          {healthy ? (isDefault ? 'Sending through this' : getConnectorSpec(connector.kind).label) : 'Needs attention'}
                        </span>
                      </span>
                      {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                    </Button>
                  )
                })
              )}
            </SettingsListSection>
          )}

          <SettingsListSection label="Add connector">
            {CONNECTOR_SPECS.map((spec) => {
              const active = addKind === spec.kind
              return (
                <Button
                  key={spec.kind}
                  type="button"
                  variant="ghost"
                  size="md"
                  fullWidth
                  active={active}
                  align="start"
                  className={ws.settingsListItem}
                  onClick={() => setSelection({ kind: 'add', connectorKind: spec.kind })}
                  aria-current={active ? 'true' : undefined}
                >
                  <ConnectorMark kind={spec.kind} size="sm" />
                  <span className={ws.settingsListIdentity}>
                    <span className={ws.settingsListLabel}>{spec.label}</span>
                    <span className={ws.settingsListMeta}>{spec.shortLabel}</span>
                  </span>
                  {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                </Button>
              )
            })}
          </SettingsListSection>
        </div>
      </aside>

      <div className={ws.settingsDetailCanvas}>
        {selected && overview ? (
          <ConnectorDetail
            key={selected.id}
            connector={selected}
            overview={overview}
            onChanged={onChanged}
            onRemove={() => setRemoveCandidate(selected)}
            onNavigateToDefaults={onNavigateToDefaults}
          />
        ) : addKind ? (
          <ConnectorSetupPanel
            key={addKind}
            spec={getConnectorSpec(addKind)}
            privateHostsAllowed={overview?.privateHostsAllowed ?? false}
            onCreated={(connector) => {
              setSelection({ kind: 'connector', id: connector.id })
              onChanged()
            }}
          />
        ) : null}
      </div>

      {removeCandidate && (
        <Dialog
          open
          onClose={() => setRemoveCandidate(null)}
          title="Remove connector?"
          size="sm"
          footer={(
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => setRemoveCandidate(null)} disabled={removing}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => void handleRemove(removeCandidate)} busy={removing}>
                <TrashSolidIcon size={13} aria-hidden="true" />
                <span>Remove connector</span>
              </Button>
            </>
          )}
        >
          <p className={ws.removeDialogCopy}>
            This permanently removes <strong>{removeCandidate.label}</strong> and its stored secret.
            {overview?.defaults.defaultConnectorId === removeCandidate.id
              && ' It is the connector the site sends through, so email stops going out until you choose another.'}
          </p>
        </Dialog>
      )}
    </section>
  )
}

function ConnectorDetail({
  connector,
  overview,
  onChanged,
  onRemove,
  onNavigateToDefaults,
}: {
  connector: MailConnector
  overview: MailOverview
  onChanged: () => void
  onRemove: () => void
  onNavigateToDefaults: () => void
}) {
  const user = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const spec = getConnectorSpec(connector.kind)
  const secretName = spec.secretLabel.toLowerCase()
  const testInputId = useId()
  const secretInputId = useId()
  const [dialog, setDialog] = useState<'test' | 'secret' | null>(null)
  const [testTo, setTestTo] = useState(user?.email ?? '')
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [secret, setSecret] = useState('')
  const [savingSecret, setSavingSecret] = useState(false)

  const isDefault = overview.defaults.defaultConnectorId === connector.id
  const hasSender = overview.defaults.fromAddress !== ''
  const status = connector.secretNeedsReentry
    ? `Re-enter ${secretName}`
    : connector.lastError
      ? 'Last send failed'
      : isDefault ? 'Sending through this' : 'Connected'
  const healthy = !connector.secretNeedsReentry && connector.lastError === null

  async function handleTest() {
    setTesting(true)
    setTestError(null)
    try {
      await testCmsMailConnector(connector.id, testTo.trim())
      setDialog(null)
      pushToast({ kind: 'success', title: 'Test email sent', body: `Check the inbox of ${testTo.trim()}.` })
    } catch (err) {
      setTestError(getErrorMessage(err, 'The test email was not sent.'))
    } finally {
      setTesting(false)
      onChanged()
    }
  }

  async function handleSaveSecret() {
    setSavingSecret(true)
    try {
      await runStepUp(() => setCmsMailConnectorSecret(connector.id, secret))
      setSecret('')
      setDialog(null)
      onChanged()
      pushToast({ kind: 'success', title: `${spec.secretLabel} saved` })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[ConnectorsTab] secret save failed:', err)
      pushToast({ kind: 'error', title: `Could not save the ${secretName}`, body: getErrorMessage(err, 'Unknown error') })
    } finally {
      setSavingSecret(false)
    }
  }

  return (
    <article className={ws.credentialDetail} aria-labelledby="connector-detail-title">
      <header className={ws.credentialDetailHeader}>
        <div className={ws.credentialDetailIdentity}>
          <ConnectorMark kind={connector.kind} size="lg" />
          <div>
            <div className={ws.credentialTitleRow}>
              <h2 id="connector-detail-title">{connector.label}</h2>
              <span className={healthy ? ws.connectionStatus : ws.connectionStatusWarning}>
                <span className={healthy ? ws.healthDot : ws.warningDot} />
                {status}
              </span>
            </div>
            <p>{spec.label}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {!isDefault && (
            <Button type="button" variant="ghost" size="md" onClick={onNavigateToDefaults}>
              Use for sending
            </Button>
          )}
          {hasSender ? (
            <Button type="button" variant="secondary" size="md" onClick={() => { setTestError(null); setDialog('test') }}>
              <SendSolidIcon size={14} aria-hidden="true" />
              <span>Send test</span>
            </Button>
          ) : (
            <Button type="button" variant="secondary" size="md" onClick={onNavigateToDefaults} tooltip="A test needs a sender address">
              <span>Set a sender address</span>
              <ArrowRightIcon size={13} aria-hidden="true" />
            </Button>
          )}
        </div>
      </header>

      {connector.secretNeedsReentry && (
        <p role="status" className={ws.connectionResultError}>
          The server secret key changed, so the stored {secretName} can no longer be read. Enter it again.
        </p>
      )}
      {connector.lastError && <p role="status" className={ws.connectionResultError}>{connector.lastError}</p>}

      <section className={ws.detailSection}>
        <div className={ws.detailSectionHeader}>
          <div><h3>Connection</h3></div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDialog('secret')}>
            {connector.secretNeedsReentry ? `Enter ${secretName}` : `Replace ${secretName}`}
          </Button>
        </div>
        <dl className={ws.connectionDetails}>
          {connector.kind === 'smtp' ? (
            <>
              <DetailRow label="Host" value={connector.config.host} code />
              <DetailRow label="Port" value={String(connector.config.port)} />
              <DetailRow label="Security" value={connector.config.port === 465 ? 'TLS from the start' : 'STARTTLS before signing in'} />
              <DetailRow label="Username" value={connector.config.username || 'None (open relay)'} />
            </>
          ) : (
            <>
              <DetailRow label="Region" value={connector.config.region} code />
              <DetailRow label="Access key ID" value={connector.config.accessKeyId} code />
            </>
          )}
          <DetailRow label={spec.secretLabel} value={connector.hasSecret ? 'Stored encrypted' : 'None'} />
          <DetailRow
            label="Last used"
            value={connector.lastUsedAt ? new Date(connector.lastUsedAt).toLocaleString() : 'Not used yet'}
          />
        </dl>
      </section>

      <div className={ws.credentialDangerZone}>
        <Button type="button" variant="ghost" tone="danger" size="sm" onClick={onRemove}>
          <TrashSolidIcon size={14} aria-hidden="true" />
          <span>Remove connector</span>
        </Button>
        <p>This permanently deletes the connector and its stored secret.</p>
      </div>

      {dialog === 'test' && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title="Send a test email"
          size="sm"
          footer={(
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => setDialog(null)} disabled={testing}>Cancel</Button>
              <Button type="button" variant="primary" size="sm" onClick={() => void handleTest()} disabled={!ADDRESS_RE.test(testTo.trim())} busy={testing}>
                Send test
              </Button>
            </>
          )}
        >
          <div className={styles.testDialog}>
            <div className={styles.field}>
              <label htmlFor={testInputId}>Send to</label>
              <Input id={testInputId} type="email" value={testTo} onChange={(event) => setTestTo(event.currentTarget.value)} placeholder="you@example.com" />
              <p className={styles.hint}>Goes through {connector.label}, whether or not it is the connector the site sends through.</p>
            </div>
            {testError && <p role="alert" className={ws.connectionResultError}>{testError}</p>}
          </div>
        </Dialog>
      )}

      {dialog === 'secret' && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title={connector.secretNeedsReentry ? `Enter the ${secretName} again` : `Replace the ${secretName}`}
          size="sm"
          footer={(
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => setDialog(null)} disabled={savingSecret}>Cancel</Button>
              <Button type="button" variant="primary" size="sm" onClick={() => void handleSaveSecret()} disabled={secret === ''} busy={savingSecret}>
                Save {secretName}
              </Button>
            </>
          )}
        >
          <div className={styles.field}>
            <label htmlFor={secretInputId}>{spec.secretLabel}</label>
            <Input
              id={secretInputId}
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.currentTarget.value)}
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
            />
            <p className={styles.hint}>Stored encrypted and never shown again.</p>
          </div>
        </Dialog>
      )}
    </article>
  )
}

function DetailRow({ label, value, code = false }: { label: string; value: string; code?: boolean }) {
  return (
    <div className={ws.connectionDetailRow}>
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  )
}

function ConnectorSetupPanel({
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
        <ConnectorMark kind={spec.kind} size="lg" />
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
            <p>The {spec.secretLabel.toLowerCase()} is encrypted before it is stored and never shown again.</p>
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
  const ids = { label: useId(), host: useId(), port: useId(), username: useId(), region: useId(), key: useId(), secret: useId() }
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('587')
  const [username, setUsername] = useState('')
  const [region, setRegion] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const input: MailConnectorInput = spec.kind === 'smtp'
      ? { kind: 'smtp', label: label.trim(), config: { host: host.trim(), port: Number(port), username: username.trim() }, secret }
      : { kind: 'ses', label: label.trim(), config: { region: region.trim(), accessKeyId: accessKeyId.trim() }, secret }
    setBusy(true)
    try {
      const connector = await runStepUp(() => createCmsMailConnector(input))
      onCreated(connector)
      pushToast({ kind: 'success', title: `${spec.label} connected`, body: 'Send a test email to check it works.' })
    } catch (err) {
      if (isCancelledStepUp(err)) return
      console.error('[ConnectorsTab] create failed:', err)
      pushToast({ kind: 'error', title: `Could not connect ${spec.label}`, body: getErrorMessage(err, 'Check the details and try again.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={ws.providerSetupForm} onSubmit={(event) => void handleSubmit(event)}>
      <div className={ws.providerSetupField}>
        <label htmlFor={ids.label}>Display label</label>
        <div>
          <Input id={ids.label} value={label} onChange={(event) => setLabel(event.currentTarget.value)} placeholder={`e.g. ${spec.label} production`} required />
          <p>A name teammates will recognise.</p>
        </div>
      </div>

      {spec.kind === 'smtp' ? (
        <>
          <div className={ws.providerSetupField}>
            <label htmlFor={ids.host}>Host</label>
            <div>
              <Input id={ids.host} value={host} onChange={(event) => setHost(event.currentTarget.value)} placeholder="smtp.example.com" pattern="[a-zA-Z0-9.\-]+" spellCheck={false} required />
              <p>
                {privateHostsAllowed
                  ? 'The mail server’s name. Private and local relays are allowed on this server.'
                  : 'The mail server’s public name. A relay on this machine or network needs MAIL_ALLOW_PRIVATE_HOSTS=1 on the server.'}
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
            <label htmlFor={ids.username}>Username<span>Optional</span></label>
            <div>
              <Input id={ids.username} value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="off" spellCheck={false} />
            </div>
          </div>
        </>
      ) : (
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

      <div className={ws.providerSetupField}>
        <label htmlFor={ids.secret}>
          {spec.secretLabel}
          {spec.kind === 'smtp' && <span>Optional</span>}
        </label>
        <div>
          <Input
            id={ids.secret}
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.currentTarget.value)}
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            required={spec.kind === 'ses'}
          />
          <p>Stored encrypted and never displayed again.</p>
        </div>
      </div>

      <div className={ws.providerSetupActions}>
        <Button type="submit" variant="primary" size="md" busy={busy}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Connect {spec.label}</span>
        </Button>
      </div>
    </form>
  )
}
