/**
 * MCP tab — create, list, and revoke MCP connectors.
 *
 * A connector lets an external MCP client (Claude Code, Codex, a remote agent)
 * connect to this instance and operate the CMS tools, exactly as the built-in
 * AI panel does. The bearer token is shown ONCE on creation; only its hash is
 * stored server-side. Capabilities offered are filtered to those the current
 * admin holds — you cannot mint a connector more powerful than yourself.
 *
 * The capability picker reuses the Role dialog's styles + `CAPABILITY_META`
 * (`users/utils/capabilities`) so the two stay visually consistent.
 */
import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { hasCapability } from '@admin/access'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { ApiError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { CoreCapability } from '@core/capabilities'
import type { McpConnectorView, McpConnectorType, CreateMcpConnectorResult } from '@core/ai'
import { CapabilityPicker, type CapabilityPickerGroup } from '@admin/shared/CapabilityPicker'
import {
  listMcpConnectors,
  createMcpConnector,
  revokeMcpConnector,
} from '../../../ai/api'
import dialogStyles from '../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'
import styles from '../AiPage.module.css'
import mcpStyles from './McpTab.module.css'

// MCP-relevant capabilities, grouped read vs. write — the surface an external
// client can actually exercise. Labels/descriptions come from CAPABILITY_META
// (the same source the Role dialog uses) so wording stays consistent.
// Capabilities that map to an exposed MCP tool (headless reads + the
// browser-relayed write tools). Grouped for the picker; every entry here gates
// at least one tool the connector can actually call.
const MCP_CAPABILITY_GROUPS: readonly CapabilityPickerGroup[] = [
  {
    title: 'Read',
    capabilities: ['site.read', 'content.manage', 'data.custom.tables.read', 'data.system.tables.read', 'media.read'],
  },
  {
    title: 'Allow writes',
    capabilities: ['ai.tools.write'],
  },
  {
    title: 'Site editing',
    capabilities: ['site.structure.edit', 'site.content.edit', 'site.style.edit'],
  },
  {
    title: 'Pages',
    capabilities: ['pages.edit', 'pages.publish'],
  },
  {
    title: 'Content',
    capabilities: ['content.create', 'content.edit.own', 'content.edit.any', 'content.publish.own', 'content.publish.any'],
  },
  {
    title: 'Media',
    capabilities: ['media.write', 'media.replace', 'media.delete'],
  },
]

const READ_GROUP_CAPS = MCP_CAPABILITY_GROUPS[0].capabilities

const TYPE_OPTIONS: Array<{ value: McpConnectorType; label: string }> = [
  { value: 'local', label: 'Local (Claude Code, Codex, Cursor)' },
  { value: 'remote', label: 'Remote (hosted endpoint for remote agents)' },
]

async function revokeConnectorAction(
  id: string,
  setBusyIds: (updater: (prev: Set<string>) => Set<string>) => void,
  setActionError: (error: string | null) => void,
  refresh: () => void,
): Promise<void> {
  setBusyIds((prev) => new Set(prev).add(id))
  try {
    await revokeMcpConnector(id)
    setActionError(null)
    refresh()
  } catch (err) {
    setActionError(getErrorMessage(err, 'Failed to revoke connector.'))
  } finally {
    setBusyIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }
}

export function McpTab() {
  const {
    data: loaded,
    loading,
    error: loadError,
    refresh,
  } = useAsyncResource(() => listMcpConnectors(), [], {
    fallbackError: 'Failed to load connectors.',
  })
  const connectors: McpConnectorView[] = loaded ?? []
  const [showDialog, setShowDialog] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const error = loadError ?? actionError

  async function handleRevoke(id: string) {
    await revokeConnectorAction(id, setBusyIds, setActionError, refresh)
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>MCP connectors</h2>
          <p>
            Let external AI clients (Claude Code, Codex, remote agents) operate this site over the
            Model Context Protocol. Tokens are shown once and stored hashed.
          </p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={() => setShowDialog(true)}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Add connector</span>
        </Button>
      </div>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : connectors.length === 0 ? (
        <div className={styles.emptyState}>
          No connectors yet. Add one to let an AI client connect to this instance.
        </div>
      ) : (
        <div className={styles.credentialGrid}>
          {connectors.map((connector) => {
            const isBusy = busyIds.has(connector.id)
            return (
              <div key={connector.id} className={styles.credentialCard}>
                <div className={styles.credentialIdentity}>
                  <div className={styles.credentialLabel}>{connector.label}</div>
                  <div className={styles.credentialMeta}>
                    <span>{connector.type === 'local' ? 'Local' : 'Remote'}</span>
                    <span>·</span>
                    <span>{connector.capabilities.length} capabilities</span>
                    {connector.revoked && (
                      <>
                        <span>·</span>
                        <span className={`${styles.statusBadge} ${styles.danger}`}>Revoked</span>
                      </>
                    )}
                    {connector.lastUsedAt && (
                      <>
                        <span>·</span>
                        <span>Last used {new Date(connector.lastUsedAt).toLocaleString()}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className={styles.credentialActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleRevoke(connector.id)}
                    disabled={isBusy || connector.revoked}
                  >
                    <TrashSolidIcon size={14} aria-hidden="true" />
                    <span>{connector.revoked ? 'Revoked' : 'Revoke'}</span>
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showDialog && (
        <AddConnectorDialog
          onClose={() => setShowDialog(false)}
          onCreated={() => {
            setActionError(null)
            refresh()
          }}
        />
      )}
    </section>
  )
}

const CONNECTOR_FORM_ID = 'mcp-connector-form'

function AddConnectorDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const labelInputId = useId()
  const typeInputId = useId()
  const currentUser = useCurrentAdminUser()

  // Groups filtered to the capabilities the current admin can actually grant
  // (the unrestricted dev/owner session — currentUser null — sees everything).
  // Render only the capabilities the current admin can actually grant (the
  // unrestricted dev/owner session — currentUser null — sees everything).
  const groups: CapabilityPickerGroup[] = MCP_CAPABILITY_GROUPS
    .map((group) => ({
      title: group.title,
      capabilities: group.capabilities.filter((cap) => !currentUser || hasCapability(currentUser, cap)),
    }))
    .filter((group) => group.capabilities.length > 0)
  const readDefaults = groups.flatMap((g) => g.capabilities).filter((cap) => READ_GROUP_CAPS.includes(cap))

  const [label, setLabel] = useState('')
  const [type, setType] = useState<McpConnectorType>('local')
  const [selected, setSelected] = useState<Set<CoreCapability>>(() => new Set(readDefaults))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreateMcpConnectorResult | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      // `ai.chat` marks the connector as an AI caller, mirroring the built-in
      // panel. Always granted when the admin holds it.
      const capabilities = [...selected]
      if ((!currentUser || hasCapability(currentUser, 'ai.chat')) && !capabilities.includes('ai.chat')) {
        capabilities.push('ai.chat')
      }
      const result = await createMcpConnector({ label, type, capabilities })
      setCreated(result)
      onCreated()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : getErrorMessage(err, 'Failed to create connector.'))
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return <TokenResultDialog result={created} onClose={onClose} />
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add MCP connector"
      size="xl"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button type="submit" form={CONNECTOR_FORM_ID} variant="primary" size="sm" disabled={busy || selected.size === 0}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Create connector</span>
          </Button>
        </>
      }
    >
      <form id={CONNECTOR_FORM_ID} className={dialogStyles.form} onSubmit={(e) => void handleSubmit(e)}>
        <div className={dialogStyles.field}>
          <label htmlFor={labelInputId} className={dialogStyles.label}>Label</label>
          <Input
            id={labelInputId}
            value={label}
            onChange={(e) => setLabel(e.currentTarget.value)}
            placeholder="e.g. My laptop (Claude Code)"
            required
          />
        </div>
        <div className={dialogStyles.field}>
          <label htmlFor={typeInputId} className={dialogStyles.label}>Type</label>
          <Select
            id={typeInputId}
            value={type}
            onChange={(e) => setType(e.currentTarget.value as McpConnectorType)}
            options={TYPE_OPTIONS}
          />
        </div>

        <CapabilityPicker groups={groups} selected={selected} onChange={setSelected} />

        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}

function TokenResultDialog({
  result,
  onClose,
}: {
  result: CreateMcpConnectorResult
  onClose: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const endpoint = `${origin}/_instatic/mcp`
  const claudeCommand = `claude mcp add instatic --transport http ${endpoint} --header "Authorization: Bearer ${result.token}"`

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
    } catch (err) {
      console.error('[McpTab] clipboard write failed:', err)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Connector created"
      size="lg"
      footer={
        <Button type="button" variant="primary" size="sm" onClick={onClose}>
          <span>Done</span>
        </Button>
      }
    >
      <div className={mcpStyles.tokenBody}>
        <p role="status" className={mcpStyles.tokenNotice}>
          Copy this token now. It will not be shown again.
        </p>

        <div className={dialogStyles.field}>
          <span className={dialogStyles.label}>Token</span>
          <div className={mcpStyles.copyRow}>
            <code className={mcpStyles.codeBlock}>{result.token}</code>
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy(result.token, 'token')}>
              <span>{copied === 'token' ? 'Copied' : 'Copy'}</span>
            </Button>
          </div>
        </div>

        {result.connector.type === 'local' ? (
          <div className={dialogStyles.field}>
            <span className={dialogStyles.label}>Add to Claude Code / Codex</span>
            <div className={mcpStyles.copyRow}>
              <code className={mcpStyles.codeBlock}>{claudeCommand}</code>
              <Button type="button" variant="secondary" size="sm" onClick={() => void copy(claudeCommand, 'cmd')}>
                <span>{copied === 'cmd' ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
          </div>
        ) : (
          <div className={dialogStyles.field}>
            <span className={dialogStyles.label}>Endpoint</span>
            <div className={mcpStyles.copyRow}>
              <code className={mcpStyles.codeBlock}>{endpoint}</code>
              <Button type="button" variant="secondary" size="sm" onClick={() => void copy(endpoint, 'url')}>
                <span>{copied === 'url' ? 'Copied' : 'Copy'}</span>
              </Button>
            </div>
            <p className={styles.secondaryText}>
              Send the token as an <code>Authorization: Bearer</code> header. ChatGPT/Gemini managed
              connectors require OAuth (coming soon); the token works today with Claude, Cursor, and
              custom remote agents.
            </p>
          </div>
        )}
      </div>
    </Dialog>
  )
}
