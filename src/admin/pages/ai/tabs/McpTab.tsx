/** MCP connection management in the shared AI master-detail workspace. */
import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import { ArrowRightIcon } from 'pixel-art-icons/icons/arrow-right'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { GlobeSolidIcon } from 'pixel-art-icons/icons/globe-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { CoreCapability } from '@core/capabilities'
import type {
  CreateMcpAccessTokenResult,
  McpConnectionOverview,
  McpConnectionView,
} from '@core/ai'
import { CapabilityPicker } from '@admin/shared/CapabilityPicker'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import {
  createMcpAccessToken,
  getMcpConnectionOverview,
  revokeMcpConnection,
} from '../../../ai/api'
import {
  availableMcpCapabilityGroups,
  defaultMcpReadCapabilities,
} from './mcpCapabilities'
import { AiSettingsListSection } from '../AiSettingsListSection'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from '../AiPage.module.css'
import mcpStyles from './McpTab.module.css'

const TTL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
]

type McpSetupMode = 'oauth' | 'token'
type McpSelection =
  | { kind: 'setup'; mode: McpSetupMode }
  | { kind: 'connection'; id: string }

export function McpTab() {
  const {
    data: overview,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(() => getMcpConnectionOverview(), [], {
    fallbackError: 'Failed to load MCP connections.',
  })
  const [selection, setSelection] = useState<McpSelection | null>(null)
  const [showTokenDialog, setShowTokenDialog] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())

  const connections = overview?.connections ?? []
  const endpoint = overview?.endpoint ?? ''
  const requestedConnection = selection?.kind === 'connection'
    ? connections.find((connection) => connection.id === selection.id)
    : undefined
  const effectiveSelection: McpSelection = selection?.kind === 'setup'
    ? selection
    : requestedConnection
      ? { kind: 'connection', id: requestedConnection.id }
      : connections[0]
        ? { kind: 'connection', id: connections[0].id }
        : { kind: 'setup', mode: 'oauth' }
  const selectedConnection = effectiveSelection.kind === 'connection'
    ? connections.find((connection) => connection.id === effectiveSelection.id)
    : undefined

  async function handleRevoke(connection: McpConnectionView) {
    setBusyIds((previous) => new Set(previous).add(connection.id))
    try {
      await revokeMcpConnection(connection.id)
      refresh()
    } catch (err) {
      pushToast({
        kind: 'error',
        title: connection.authMode === 'oauth' ? 'Could not disconnect client' : 'Could not revoke token',
        body: getErrorMessage(err, 'Unknown MCP connection error'),
      })
    } finally {
      setBusyIds((previous) => {
        const next = new Set(previous)
        next.delete(connection.id)
        return next
      })
    }
  }

  return (
    <section className={styles.settingsWorkspace} aria-labelledby="mcp-heading">
      <aside className={styles.settingsBrowser} aria-label="MCP connection browser">
        <div className={styles.settingsBrowserHeader}>
          <h2 id="mcp-heading">MCP connections</h2>
        </div>

        {loadError && <p role="alert" className={styles.settingsBrowserError}>{loadError}</p>}

        <div className={styles.settingsBrowserSections}>
          {(loading || connections.length > 0) && (
            <AiSettingsListSection label="Authorized">
              {loading && connections.length === 0 ? (
                <p className={styles.settingsBrowserEmpty}>Loading connections…</p>
              ) : (
                connections.map((connection) => {
                  const active = effectiveSelection.kind === 'connection'
                    && effectiveSelection.id === connection.id
                  return (
                    <Button
                      key={connection.id}
                      type="button"
                      variant="ghost"
                      size="md"
                      fullWidth
                      active={active}
                      align="start"
                      className={styles.settingsListItem}
                      onClick={() => setSelection({ kind: 'connection', id: connection.id })}
                      aria-current={active ? 'true' : undefined}
                    >
                      <McpMark mode={connection.authMode === 'oauth' ? 'oauth' : 'token'} />
                      <span className={styles.settingsListIdentity}>
                        <span className={styles.settingsListLabel}>{connection.label}</span>
                        <span className={styles.settingsListMeta}>
                          {connection.revoked
                            ? 'Revoked'
                            : `${connection.capabilities.length} permissions`}
                        </span>
                      </span>
                      {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                    </Button>
                  )
                })
              )}
            </AiSettingsListSection>
          )}

          <AiSettingsListSection label="Add connection">
            {(['oauth', 'token'] as const).map((mode) => {
              const active = effectiveSelection.kind === 'setup' && effectiveSelection.mode === mode
              const oauth = mode === 'oauth'
              return (
                <Button
                  key={mode}
                  type="button"
                  variant="ghost"
                  size="md"
                  fullWidth
                  active={active}
                  align="start"
                  className={styles.settingsListItem}
                  onClick={() => setSelection({ kind: 'setup', mode })}
                  aria-current={active ? 'true' : undefined}
                >
                  <McpMark mode={mode} />
                  <span className={styles.settingsListIdentity}>
                    <span className={styles.settingsListLabel}>
                      {oauth ? 'Remote OAuth' : 'Personal token'}
                    </span>
                    <span className={styles.settingsListMeta}>
                      {oauth ? 'Hosted clients' : 'Local and CLI clients'}
                    </span>
                  </span>
                  {!active && <ArrowRightIcon size={13} aria-hidden="true" />}
                </Button>
              )
            })}
          </AiSettingsListSection>
        </div>
      </aside>

      <div className={styles.settingsDetailCanvas}>
        {loading ? (
          <div className={styles.emptyState}>Loading connections…</div>
        ) : loadError ? (
          <p role="alert" className={styles.errorAlert}>{loadError}</p>
        ) : selectedConnection ? (
          <ConnectionDetail
            connection={selectedConnection}
            busy={busyIds.has(selectedConnection.id)}
            onRevoke={() => handleRevoke(selectedConnection)}
          />
        ) : effectiveSelection.kind === 'setup' && effectiveSelection.mode === 'token' ? (
          <TokenSetupPanel onCreate={() => setShowTokenDialog(true)} />
        ) : (
          <OAuthSetupPanel overview={overview} />
        )}
      </div>

      {showTokenDialog && endpoint && (
        <CreateAccessTokenDialog
          endpoint={endpoint}
          onClose={() => setShowTokenDialog(false)}
          onCreated={refresh}
        />
      )}
    </section>
  )
}

function McpMark({ mode, large = false }: { mode: McpSetupMode; large?: boolean }) {
  const Icon = mode === 'oauth' ? GlobeSolidIcon : CodeIcon
  return (
    <span
      className={cn(
        large ? styles.settingsHeroIcon : styles.settingsItemIcon,
        mode === 'oauth' ? mcpStyles.oauthIcon : mcpStyles.tokenIcon,
      )}
      aria-hidden="true"
    >
      <Icon size={large ? 22 : 16} />
    </span>
  )
}

function OAuthSetupPanel({
  overview,
}: {
  overview: McpConnectionOverview | null | undefined
}) {
  const endpoint = overview?.endpoint ?? ''
  return (
    <article className={styles.settingsDetail} aria-labelledby="mcp-oauth-title">
      <header className={styles.settingsDetailHeader}>
        <McpMark mode="oauth" large />
        <div className={styles.settingsDetailIdentity}>
          <span className={styles.detailEyebrow}>Hosted OAuth</span>
          <h2 id="mcp-oauth-title">Connect a remote client</h2>
          <p>Claude, ChatGPT, and remote agents authorize through Instatic.</p>
        </div>
      </header>

      <section className={styles.settingsDetailSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Remote MCP URL</h3>
            <p>The client returns here so you can choose permissions and approve access.</p>
          </div>
        </div>
        <CopyField
          label="Connector endpoint"
          value={endpoint || 'Loading…'}
          copyLabel="Copy URL"
          disabled={!endpoint}
        />
        {overview && (
          overview.remoteAccess === 'local-only' ? (
            <ReadinessNotice
              tone="warning"
              title="Available on this device only"
              message="Hosted clients connect from the cloud. Publish Instatic at a public HTTPS URL before adding this connector."
            />
          ) : (
            <ReadinessNotice
              tone="success"
              title="Public HTTPS is ready"
              message="Hosted clients can reach this URL. Confirm your firewall allows incoming connector requests."
            />
          )
        )}
      </section>

      <section className={styles.settingsDetailSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Connect from the client</h3>
            <p>OAuth Client ID and Secret are discovered automatically.</p>
          </div>
        </div>
        <ol className={mcpStyles.steps}>
          <li>Open the client&apos;s connector settings and choose a custom MCP connector.</li>
          <li>Paste the URL above. Leave OAuth Client ID and Secret empty.</li>
          <li>Choose Connect, then approve the requested capabilities in Instatic.</li>
        </ol>
      </section>
    </article>
  )
}

function ReadinessNotice({
  tone,
  title,
  message,
}: {
  tone: 'warning' | 'success'
  title: string
  message: string
}) {
  const Icon = tone === 'warning' ? WarningDiamondSolidIcon : CheckIcon
  return (
    <div role="status" className={mcpStyles.readinessNotice} data-tone={tone}>
      <span className={mcpStyles.readinessNoticeIcon} aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className={mcpStyles.readinessNoticeCopy}>
        <strong>{title}</strong>
        <span>{message}</span>
      </span>
    </div>
  )
}

function TokenSetupPanel({ onCreate }: { onCreate: () => void }) {
  return (
    <article className={styles.settingsDetail} aria-labelledby="mcp-token-title">
      <header className={styles.settingsDetailHeader}>
        <McpMark mode="token" large />
        <div className={styles.settingsDetailIdentity}>
          <span className={styles.detailEyebrow}>Local and CLI</span>
          <h2 id="mcp-token-title">Create a personal token</h2>
          <p>Connect Claude Code, Codex, Cursor, Desktop, or another local client.</p>
        </div>
        <span className={mcpStyles.tokenBadge}>Token</span>
      </header>

      <section className={styles.settingsDetailSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Scoped access</h3>
            <p>Choose only the permissions and lifetime this client needs.</p>
          </div>
        </div>
        <ul className={mcpStyles.featureList}>
          <li>The secret is displayed once and stored only as a hash.</li>
          <li>Each client receives its own independently revocable credential.</li>
          <li>Generated setup commands include the correct MCP endpoint and authorization header.</li>
        </ul>
        <div className={styles.settingsDetailActions}>
          <Button type="button" variant="primary" size="md" onClick={onCreate}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Create access token</span>
          </Button>
        </div>
      </section>
    </article>
  )
}

function ConnectionDetail({
  connection,
  busy,
  onRevoke,
}: {
  connection: McpConnectionView
  busy: boolean
  onRevoke: () => Promise<void>
}) {
  const mode: McpSetupMode = connection.authMode === 'oauth' ? 'oauth' : 'token'
  return (
    <article className={styles.settingsDetail} aria-labelledby="mcp-connection-title">
      <header className={styles.settingsDetailHeader}>
        <McpMark mode={mode} large />
        <div className={styles.settingsDetailIdentity}>
          <span className={styles.detailEyebrow}>Authorized connection</span>
          <h2 id="mcp-connection-title">{connection.label}</h2>
          <p>{connection.authMode === 'oauth' ? 'Hosted OAuth client' : 'Personal access token'}</p>
        </div>
        <span className={connection.revoked ? styles.connectionStatusWarning : styles.connectionStatus}>
          {connection.revoked ? 'Revoked' : 'Active'}
        </span>
      </header>

      <section className={styles.settingsDetailSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Connection details</h3>
            <p>Lifecycle and authentication information for this client.</p>
          </div>
        </div>
        <dl className={styles.connectionDetails}>
          <ConnectionDetailRow label="Authentication" value={connection.authMode === 'oauth' ? 'OAuth 2.1' : 'Bearer token'} />
          <ConnectionDetailRow label="Created" value={formatDateTime(connection.createdAt)} />
          <ConnectionDetailRow label="Last used" value={connection.lastUsedAt ? formatDateTime(connection.lastUsedAt) : 'Never'} />
          <ConnectionDetailRow label="Expires" value={connection.expiresAt ? formatDateTime(connection.expiresAt) : 'No expiry'} />
        </dl>
      </section>

      <section className={styles.settingsDetailSection}>
        <div className={styles.detailSectionHeader}>
          <div>
            <h3>Granted permissions</h3>
            <p>{connection.capabilities.length} capabilities approved for this connection.</p>
          </div>
        </div>
        <div className={mcpStyles.capabilityList}>
          {connection.capabilities.map((capability) => (
            <code key={capability} className={mcpStyles.capabilityChip}>{capability}</code>
          ))}
        </div>
      </section>

      <div className={styles.credentialDangerZone}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          tone="danger"
          onClick={() => void onRevoke()}
          disabled={busy || connection.revoked}
        >
          <TrashSolidIcon size={14} aria-hidden="true" />
          <span>
            {connection.revoked
              ? 'Revoked'
              : connection.authMode === 'oauth' ? 'Disconnect client' : 'Revoke token'}
          </span>
        </Button>
        <p>This immediately prevents the client from calling Instatic tools.</p>
      </div>
    </article>
  )
}

function ConnectionDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.connectionDetailRow}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

const ACCESS_TOKEN_FORM_ID = 'mcp-access-token-form'

function CreateAccessTokenDialog({
  endpoint,
  onClose,
  onCreated,
}: {
  endpoint: string
  onClose: () => void
  onCreated: () => void
}) {
  const labelInputId = useId()
  const ttlInputId = useId()
  const currentUser = useCurrentAdminUser()
  const { runStepUp } = useStepUp()
  const groups = availableMcpCapabilityGroups(currentUser)

  const [label, setLabel] = useState('')
  const [ttlDays, setTtlDays] = useState('90')
  const [selected, setSelected] = useState<Set<CoreCapability>>(
    () => defaultMcpReadCapabilities(groups),
  )
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreateMcpAccessTokenResult | null>(null)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const capabilities = [...selected]
      const result = await runStepUp(() => createMcpAccessToken({
        label,
        capabilities,
        ttlDays: ttlDays === 'never' ? null : parseInt(ttlDays, 10),
      }))
      setCreated(result)
      onCreated()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      pushToast({
        kind: 'error',
        title: 'Could not create access token',
        body: getErrorMessage(err, 'Unknown MCP token error'),
      })
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return <AccessTokenResultDialog endpoint={endpoint} result={created} onClose={onClose} />
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Create personal access token"
      size="xl"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button
            type="submit"
            form={ACCESS_TOKEN_FORM_ID}
            variant="primary"
            size="sm"
            disabled={busy || selected.size === 0 || !label.trim()}
          >
            <PlusIcon size={14} aria-hidden="true" />
            <span>{busy ? 'Creating…' : 'Create token'}</span>
          </Button>
        </>
      }
    >
      <form id={ACCESS_TOKEN_FORM_ID} className={dialogStyles.form} onSubmit={(event) => void handleSubmit(event)}>
        <p className={mcpStyles.dialogIntro}>
          Use a clear device or client name so you can revoke this credential without guessing later.
        </p>
        <div className={dialogStyles.field}>
          <label htmlFor={labelInputId} className={dialogStyles.label}>Token name</label>
          <Input
            id={labelInputId}
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            placeholder="e.g. MacBook — Claude Desktop"
            required
          />
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={ttlInputId} className={dialogStyles.label}>Expires after</label>
          <Select
            id={ttlInputId}
            value={ttlDays}
            onChange={(event) => setTtlDays(event.currentTarget.value)}
            options={TTL_OPTIONS}
          />
        </div>
        <CapabilityPicker groups={groups} selected={selected} onChange={setSelected} />
      </form>
    </Dialog>
  )
}

function AccessTokenResultDialog({
  endpoint,
  result,
  onClose,
}: {
  endpoint: string
  result: CreateMcpAccessTokenResult
  onClose: () => void
}) {
  const accessToken = result.accessToken
  const claudeCommand = `claude mcp add instatic --transport http ${endpoint} --header "Authorization: Bearer ${accessToken}"`
  const bridgeArgs = [
    '-y',
    'mcp-remote@latest',
    endpoint,
    ...(endpoint.startsWith('http://') ? ['--allow-http'] : []),
    '--transport',
    'http-only',
    '--header',
    'Authorization:${INSTATIC_MCP_AUTH}',
  ]
  const desktopConfig = JSON.stringify({
    mcpServers: {
      instatic: {
        command: 'npx',
        args: bridgeArgs,
        env: { INSTATIC_MCP_AUTH: `Bearer ${accessToken}` },
      },
    },
  }, null, 2)

  return (
    <Dialog
      open
      onClose={onClose}
      title="Access token created"
      size="xl"
      footer={
        <Button type="button" variant="primary" size="sm" onClick={onClose}>
          <span>Done</span>
        </Button>
      }
    >
      <div className={mcpStyles.tokenBody}>
        <p role="status" className={mcpStyles.tokenNotice}>
          Copy this token now. Instatic stores only its hash and cannot show it again.
        </p>
        <CopyField label="Personal access token" value={accessToken} copyLabel="Copy token" />
        <div className={mcpStyles.setupResult}>
          <h3>Claude Code and compatible CLIs</h3>
          <p>Run this command in your terminal.</p>
          <CopyField label="Command" value={claudeCommand} copyLabel="Copy command" />
        </div>
        <div className={mcpStyles.setupResult}>
          <h3>Claude Desktop with local Instatic</h3>
          <p>
            Merge this entry into <code>claude_desktop_config.json</code>, then completely restart
            Claude Desktop. The bridge requires Node 18 or newer.
          </p>
          <CopyField label="Desktop configuration" value={desktopConfig} copyLabel="Copy JSON" />
        </div>
      </div>
    </Dialog>
  )
}

function CopyField({
  label,
  value,
  copyLabel,
  disabled = false,
}: {
  label: string
  value: string
  copyLabel: string
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch (err) {
      console.error('[McpTab] clipboard write failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not copy to clipboard',
        body: getErrorMessage(err, 'Unknown clipboard error'),
      })
    }
  }

  return (
    <div className={mcpStyles.copyField}>
      <span className={mcpStyles.copyLabel}>{label}</span>
      <div className={mcpStyles.copyRow}>
        <code className={mcpStyles.codeBlock}>{value}</code>
        <Button
          type="button"
          variant="secondary"
          size="md"
          active={copied}
          className={mcpStyles.copyButton}
          onClick={() => void copy()}
          disabled={disabled}
        >
          {copied
            ? <CheckIcon size={13} aria-hidden="true" />
            : <CopySolidIcon size={13} aria-hidden="true" />}
          <span>{copied ? 'Copied' : copyLabel}</span>
        </Button>
      </div>
    </div>
  )
}
