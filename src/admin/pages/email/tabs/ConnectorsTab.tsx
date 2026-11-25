/** Connectors in the shared master-detail workspace: the accounts mail is sent through. */
import { Alert } from '@ui/components/Alert'
import { useId, useState } from 'react'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { WorkspaceChoice, WorkspaceChoices } from '@admin/shared/SettingsWorkspace/WorkspaceChoices'
import layout from '@admin/shared/SettingsWorkspace/WorkspaceSection.module.css'
import { WorkspaceSection } from '@admin/shared/SettingsWorkspace/WorkspaceSection'
import ws from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { pushToast } from '@ui/components/Toast'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import {
  MAIL_ADDRESS_PATTERN,
  type MailConnector,
  type MailConnectorKind,
  type MailOverview,
} from '@core/mail'
import {
  deleteCmsMailConnector,
  setCmsMailConnectorSecret,
  testCmsMailConnector,
} from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { ConnectorMark } from '../ConnectorMark'
import { CONNECTOR_SPECS, connectorLogo, getConnectorSpec } from '../connectorCatalog'
import { ConnectorSetupPanel } from './ConnectorSetup'
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
    selection ?? (connectors[0] ? { kind: 'connector', id: connectors[0].id } : { kind: 'add', connectorKind: CONNECTOR_SPECS[0].kind })
  const selected = effective.kind === 'connector'
    ? connectors.find((connector) => connector.id === effective.id)
    : undefined
  // A selected connector that has since been removed falls back to the setup panel.
  const addKind = effective.kind === 'add' ? effective.connectorKind : selected ? null : CONNECTOR_SPECS[0].kind

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
    <WorkspaceSection title="Connectors">
      {error && <Alert tone="danger">{error}</Alert>}
      {(loading || connectors.length > 0) && (
        <WorkspaceChoices title="Connected">
          {loading && connectors.length === 0 ? (
            <p className={ws.settingsBrowserEmpty}>Loading connectors…</p>
          ) : (
            connectors.map((connector) => {
              const active = effective.kind === 'connector' && effective.id === connector.id
              const healthy = !connector.secretNeedsReentry && connector.lastError === null
              const isDefault = overview?.defaults.defaultConnectorId === connector.id
              return (
                <WorkspaceChoice
                  key={connector.id}
                  icon={<ConnectorMark logo={connectorLogo(connector)} size="sm" />}
                  label={connector.label}
                  description={<>
                    <span className={healthy ? ws.healthDot : ws.warningDot} />
                    {healthy ? (isDefault ? 'Sending through this' : getConnectorSpec(connector.kind).label) : 'Needs attention'}
                  </>}
                  active={active}
                  onSelect={() => setSelection({ kind: 'connector', id: connector.id })}
                />
              )
            })
          )}
        </WorkspaceChoices>
      )}

      <WorkspaceChoices title="Add connector">
        {CONNECTOR_SPECS.map((spec) => {
          const active = addKind === spec.kind
          return (
            <WorkspaceChoice
              key={spec.kind}
              icon={<ConnectorMark logo={spec.logo} size="sm" />}
              label={spec.label}
              description={spec.shortLabel}
              active={active}
              onSelect={() => setSelection({ kind: 'add', connectorKind: spec.kind })}
            />
          )
        })}
      </WorkspaceChoices>

      <div className={layout.detailCard}>
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
    </WorkspaceSection>
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
  const secretName = spec.secretName
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
    : connector.deliveryPaused
      ? 'Delivery paused'
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
    <article className={ws.section} aria-labelledby="connector-detail-title">
      <header className={ws.credentialDetailHeader}>
        <div className={ws.credentialDetailIdentity}>
          <ConnectorMark logo={connectorLogo(connector)} size="lg" />
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
        <Alert tone="danger" role="status">
          The server secret key changed, so the stored {secretName} can no longer be read. Enter it again.
        </Alert>
      )}
      {connector.lastError && <Alert tone="danger" role="status">{connector.lastError}</Alert>}
      {connector.deliveryPaused && (
        <Alert tone="danger" role="status">
          Queued email is held. The site tries one email every two minutes and resumes by itself when one gets
          through; entering the {secretName} again or a test that works resumes it at once.
        </Alert>
      )}

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
          ) : connector.kind === 'ses' ? (
            <>
              <DetailRow label="Region" value={connector.config.region} code />
              <DetailRow label="Access key ID" value={connector.config.accessKeyId} code />
            </>
          ) : connector.kind === 'mailgun' ? (
            <>
              <DetailRow label="Sending domain" value={connector.config.domain} code />
              <DetailRow label="Region" value={connector.config.region === 'eu' ? 'EU' : 'US'} />
              <DetailRow label="Sent over" value="HTTPS, to Mailgun's API" />
            </>
          ) : (
            <DetailRow label="Sent over" value={`HTTPS, to ${spec.label}'s API`} />
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
            {testError && <Alert tone="danger">{testError}</Alert>}
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
