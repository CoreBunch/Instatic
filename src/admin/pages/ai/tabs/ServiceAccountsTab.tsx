import { useEffect, useRef, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { apiRequest } from '@core/http'
import { ServiceOverviewSchema, ServiceCodeSchema, type ServiceAccount } from '@core/serviceAccounts'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Type } from '@core/utils/typeboxHelpers'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useLocation } from '@admin/lib/routing'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { capabilityLabel } from '@admin/shared/CapabilityPicker'
import { DirectoryInspector } from '@admin/shared/Directory/DirectoryInspector'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { cn } from '@ui/cn'
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { DataTable, DataTableHead, DataTableBody, DataTableRow, DataTableHeader, DataTableCell } from '@ui/components/DataTable'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { Heading } from '@ui/components/Heading'
import { Text } from '@ui/components/Text'
import { pushToast } from '@ui/components/Toast'
import { CreateServiceAccountDialog } from './CreateServiceAccountDialog'
import styles from './ServiceAccounts.module.css'
import directory from '@admin/shared/Directory/Directory.module.css'
import layout from '@admin/shared/SettingsWorkspace/WorkspaceSection.module.css'

const base = '/admin/api/cms/service-accounts'
const IdSchema = Type.Object({ id: Type.String() })
function status(account: ServiceAccount) {
  if (account.revoked) return 'Revoked'
  if (account.expired) return 'Expired'
  return account.connected ? 'Connected' : 'Awaiting connection'
}
function useOverview() {
  const resource = useAsyncResource(signal => apiRequest(base, { schema: ServiceOverviewSchema, signal }), [], { fallbackError: 'Cannot load service accounts.' })
  const { refresh } = resource
  useEffect(() => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])
  return resource
}
function report(title: string, err: unknown) {
  if (err instanceof Error && err.message === StepUpCancelledMessage) return
  pushToast({ kind: 'error', title, body: getErrorMessage(err, title) })
}
function agentPrompt(origin: string, account: string, filename: string) {
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  return [
    'Check whether the Instatic CLI is installed with instatic --version.',
    'If it is missing, ask me for approval before installing it with:',
    'bun add --global ' + quote(origin + base + '/' + filename),
    'Then run this command and wait for me to approve the connection in my browser:',
    'instatic connect ' + quote(origin) + ' --account ' + account,
    'Use --account ' + account + ' on subsequent commands. Run instatic whoami and instatic api lookup to discover permissions and operations. For branch edits, pass --branch on reads and writes, verify your changes, and report the result here.',
  ].join('\n')
}

const expires = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const inspectorId = 'service-account-inspector'

function AccountStatus({ account }: { account: ServiceAccount }) {
  const inactive = account.revoked || account.expired
  return <span className={directory.status} data-tone={inactive ? 'neutral' : account.connected ? undefined : 'warning'}>{status(account)}</span>
}

function AccountFacts({ account }: { account: ServiceAccount }) {
  return <dl className={directory.facts}>
    <div><dt>Expires</dt><dd><time dateTime={account.expiresAt}>{expires.format(new Date(account.expiresAt))}</time></dd></div>
    <div><dt>Permissions</dt><dd>{account.capabilities.map(capabilityLabel).join(', ')}</dd></div>
  </dl>
}

export function ServiceAccountsTab({ initialAccount }: { initialAccount?: string | null }) {
  const overview = useOverview()
  const { runStepUp } = useStepUp()
  const pairing = new URLSearchParams(useLocation().search).get('pairing')
  const [id, setId] = useState(pairing ? '' : initialAccount ?? '')
  const selectedRow = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<'create' | 'revoke' | null>(null)
  const [busy, setBusy] = useState(false)
  const account = overview.data?.accounts.find(a => a.id === id)
  const origin = overview.data?.origin
  const prompt = account && origin && overview.data ? agentPrompt(origin, account.id, overview.data.cliFilename) : ''
  const active = account && !account.revoked && !account.expired
  const create = <Button variant="primary" disabled={!origin} onClick={() => setDialog('create')}>Create service account</Button>

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast({ kind: 'success', title: 'Agent prompt copied' })
    } catch (err) {
      report('Could not copy the prompt. Allow clipboard access and try again.', err)
    }
  }
  async function revoke() {
    if (!account) return
    setBusy(true)
    try {
      await apiRequest(base + '/' + account.id, { method: 'DELETE' })
      setDialog(null)
      overview.refresh()
    } catch (err) { report('Could not revoke service account', err) }
    setBusy(false)
  }
  return <div className={directory.directory} data-split={Boolean(account)}>
    <div className={directory.list}>
      {pairing === 'failed' && <Alert tone="danger">The CLI could not finish connecting. Check the terminal and run the connection command again.</Alert>}
      {pairing === 'declined' && <Text variant="muted">CLI connection request declined.</Text>}
      {overview.error && <Alert tone="danger">{overview.error}</Alert>}
      {overview.loading && !overview.data && <div role="status"><Text variant="muted">Loading service accounts…</Text></div>}
      {overview.data && !origin && <Alert tone="warning">Set PUBLIC_ORIGIN to the HTTPS address of this installation to enable CLI connections.</Alert>}
      {overview.data && (overview.data.accounts.length ? <>
        <div className={directory.toolbar}>{create}</div>
        <DataTable aria-label="Service accounts" className={directory.table} density="compact">
          <DataTableHead><DataTableRow>
            <DataTableHeader>Account</DataTableHeader>
            <DataTableHeader className={directory.accessColumn}>Permissions</DataTableHeader>
            <DataTableHeader className={directory.statusColumn}>Status</DataTableHeader>
            <DataTableHeader className={directory.loginColumn}>Expires</DataTableHeader>
          </DataTableRow></DataTableHead>
          <DataTableBody>{overview.data.accounts.map(a => <DataTableRow key={a.id} aria-current={id === a.id}>
            <DataTableCell><Button className={directory.select} variant="ghost" aria-controls={id === a.id ? inspectorId : undefined}
              aria-expanded={id === a.id} ref={id === a.id ? selectedRow : undefined} onClick={() => setId(a.id)}>
              <span className={directory.identityText}><strong>{a.label}</strong></span>
            </Button></DataTableCell>
            <DataTableCell className={directory.accessColumn}>{a.capabilities.length}</DataTableCell>
            <DataTableCell className={directory.statusColumn}><AccountStatus account={a} /></DataTableCell>
            <DataTableCell className={directory.loginColumn}>{expires.format(new Date(a.expiresAt))}</DataTableCell>
          </DataTableRow>)}</DataTableBody>
        </DataTable>
      </> : <EmptyState variant="centered" icon={<CodeIcon size={22} />} title="Connect an external agent"
        description="Choose what the agent can do and when its access expires." action={create} />)}
    </div>
    {account && <DirectoryInspector key={account.id} id={inspectorId} label="Account details" onClose={() => {
      selectedRow.current?.focus({ preventScroll: true })
      setId('')
    }}
      heading={<div className={directory.identityText}><Heading level={3}>{account.label}</Heading></div>}
      status={<AccountStatus account={account} />}>
      <AccountFacts account={account} />
      {active && <div className={styles.group}>
        {!account.connected && prompt && <Text variant="muted" size="sm">Paste the prompt into your agent, then approve its connection in your browser.</Text>}
        {account.connected && initialAccount === account.id && <Text variant="muted">Return to your agent to start working.</Text>}
        <div className={styles.actions}>
          {prompt && <Button variant={account.connected ? 'secondary' : 'primary'} onClick={copy}><CopySolidIcon size={14} />Copy agent prompt</Button>}
          <Button variant="ghost" dangerHover onClick={() => setDialog('revoke')}>Revoke access</Button>
        </div>
      </div>}
    </DirectoryInspector>}
    {dialog === 'create' && <CreateServiceAccountDialog onClose={() => setDialog(null)} onCreate={async grant => {
      try {
        const result = await runStepUp(() => apiRequest(base, { method: 'POST', schema: IdSchema, body: grant }))
        setId(result.id)
        setDialog(null)
        overview.refresh()
      } catch (err) { report('Could not create service account', err) }
    }} />}
    {dialog === 'revoke' && account && <Dialog open tone="danger" size="sm" title="Revoke access?" onClose={() => { if (!busy) setDialog(null) }}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={revoke}>Revoke access</Button>
      </>}>
      <Text>The CLI for <strong>{account.label}</strong> will lose access immediately.</Text>
    </Dialog>}
  </div>
}

export function ServiceConsent() {
  const overview = useOverview()
  const query = new URLSearchParams(useLocation().search)
  const { runStepUp } = useStepUp()
  const [busy, setBusy] = useState(false)
  const account = overview.data?.accounts.find(a => a.id === query.get('account'))
  const port = Number(query.get('port'))
  const state = query.get('state') ?? ''
  const challenge = query.get('challenge') ?? ''
  const valid = account && !account.revoked && !account.expired &&
    Number.isInteger(port) && port > 0 && port < 65536 && [state, challenge].every(s => /^[A-Za-z0-9_-]{43}$/.test(s))
  function returnToCli(result: Record<string, string>) {
    const callback = new URL('http://127.0.0.1:' + port + '/callback')
    callback.search = new URLSearchParams({ ...result, state }).toString()
    window.location.assign(callback.href)
  }
  async function approve() {
    if (!valid) return
    setBusy(true)
    try {
      const { code } = await runStepUp(() => apiRequest(base + '/' + account.id + '/approve', {
        method: 'POST', body: { challenge }, schema: ServiceCodeSchema,
      }))
      returnToCli({ code })
    } catch (err) { report('Could not authorize this CLI', err) }
    setBusy(false)
  }

  return <AdminPageLayout workspace="ai" mode="workspace">
    <section className={cn(styles.consent, styles.stack, layout.detailCard)} aria-label="Connect Instatic CLI">
      {overview.loading && !overview.data ? <Text variant="muted">Loading account…</Text> : valid ? <>
        <header className={directory.identityText}>
          <Text variant="muted" size="sm">CLI connection request</Text>
          <Heading level={3}>{account.label}</Heading>
        </header>
        <div className={styles.group}>
          <Text variant="muted">Match this code with the one in your terminal.</Text>
          <Text variant="mono" size="lg">{state.slice(0, 8)}</Text>
        </div>
        <AccountFacts account={account} />
        {account.connected && <Alert tone="warning">Approving replaces the current CLI connection.</Alert>}
        <div className={styles.actions}>
          <Button variant="primary" disabled={busy} onClick={approve}>Authorize CLI</Button>
          <Button variant="secondary" disabled={busy} onClick={() => returnToCli({ error: 'access_denied' })}>Cancel</Button>
        </div>
      </> : <Alert tone="warning">{overview.error ?? 'This request is invalid, expired, or belongs to another administrator.'}</Alert>}
    </section>
  </AdminPageLayout>
}
