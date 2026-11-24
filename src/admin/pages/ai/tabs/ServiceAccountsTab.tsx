import { useEffect, useRef, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { apiRequest } from '@core/http'
import { ServiceOverviewSchema, ServiceCodeSchema, ServiceRenewalReceiptSchema, type ServiceAccount } from '@core/serviceAccounts'
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
import { ServiceAccountLifetime } from './ServiceAccountLifetime'
import { RecentActivity } from './RecentActivity'
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
  const resource = useAsyncResource(signal => apiRequest(base, { schema: ServiceOverviewSchema, signal }), [], { fallbackError: 'Cannot load CLI connections.' })
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
    'If its version does not match ' + filename.slice('instatic-cli-'.length, -'.tgz'.length) + ' or it is missing, ask me for approval before installing this version:',
    'bun add --global ' + quote(origin + base + '/' + filename),
    'Then run this command and wait for me to approve the connection in my browser:',
    'instatic connect ' + quote(origin) + ' --account ' + account,
    'Use --account ' + account + ' on subsequent commands. Run instatic whoami to check your permissions. Use instatic api lookup to find an operation, then instatic api describe METHOD PATH with the returned method and path to see its inputs and command. For page edits, use instatic canvas read with page IDs or /slugs and --branch ID to get revisions together. Use the revision from a save or read with instatic canvas edit. Use instatic canvas inspect PAGE --branch ID --viewport WIDTHxHEIGHT and open the PNG to check visual changes. Use instatic canvas modules for module schemas and instatic canvas collection TABLE --branch ID for a bound listing example. Test search, detail links and scripts with instatic visit /PATH --branch ID. Run instatic --help for syntax. Report the result here.',
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

export function ServiceAccountsTab({ accountId, onSelect }: { accountId: string | null; onSelect: (id?: string) => void }) {
  const overview = useOverview()
  const { runStepUp } = useStepUp()
  const pairing = new URLSearchParams(useLocation().search).get('pairing')
  const id = pairing ? null : accountId
  const selectedRow = useRef<HTMLButtonElement>(null)
  const [dialog, setDialog] = useState<'create' | 'renew' | 'revoke' | null>(null)
  const [ttl, setTtl] = useState('8')
  const [busy, setBusy] = useState(false)
  const account = overview.data?.accounts.find(a => a.id === id)
  const origin = overview.data?.origin
  const prompt = account && origin && overview.data ? agentPrompt(origin, account.id, overview.data.cliFilename) : ''
  const create = <Button variant="primary" disabled={!origin} onClick={() => setDialog('create')}>Create CLI connection</Button>

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast({ kind: 'success', title: 'Agent prompt copied' })
    } catch (err) {
      report('Could not copy the prompt. Allow clipboard access and try again.', err)
    }
  }
  async function renew() {
    if (!account || busy) return
    setBusy(true)
    try {
      const receipt = await runStepUp(() => apiRequest(base + '/' + account.id + '/renew', {
        method: 'POST', body: { ttlHours: Number(ttl) }, schema: ServiceRenewalReceiptSchema,
      }))
      setDialog(null)
      pushToast({ kind: 'success', title: 'Access renewed', body: 'Expires ' + expires.format(new Date(receipt.expiresAt)) })
    } catch (err) { report('Could not renew CLI connection', err) }
    finally { setBusy(false); overview.refresh() }
  }
  async function revoke() {
    if (!account) return
    setBusy(true)
    try {
      await apiRequest(base + '/' + account.id, { method: 'DELETE' })
      setDialog(null)
      overview.refresh()
    } catch (err) { report('Could not revoke CLI connection', err) }
    setBusy(false)
  }
  return <div className={directory.directory} data-split={Boolean(account)}>
    <div className={directory.list}>
      {pairing === 'failed' && <Alert tone="danger">The CLI could not finish connecting. Check the terminal and run the connection command again.</Alert>}
      {pairing === 'declined' && <Text variant="muted">CLI connection request declined.</Text>}
      {overview.error && <Alert tone="danger">{overview.error}</Alert>}
      {overview.loading && !overview.data && <div role="status"><Text variant="muted">Loading CLI connections…</Text></div>}
      {overview.data && !origin && <Alert tone="warning">Set PUBLIC_ORIGIN to the HTTPS address of this installation to enable CLI connections.</Alert>}
      {overview.data && (overview.data.accounts.length ? <>
        <div className={directory.toolbar}>{create}</div>
        <DataTable aria-label="CLI connections" className={directory.table} density="compact">
          <DataTableHead><DataTableRow>
            <DataTableHeader>Connection</DataTableHeader>
            <DataTableHeader className={directory.accessColumn}>Permissions</DataTableHeader>
            <DataTableHeader className={directory.statusColumn}>Status</DataTableHeader>
            <DataTableHeader className={directory.loginColumn}>Expires</DataTableHeader>
          </DataTableRow></DataTableHead>
          <DataTableBody>{overview.data.accounts.map(a => <DataTableRow key={a.id} aria-current={id === a.id}>
            <DataTableCell><Button className={directory.select} variant="ghost" aria-controls={id === a.id ? inspectorId : undefined}
              aria-expanded={id === a.id} ref={id === a.id ? selectedRow : undefined} onClick={() => onSelect(a.id)}>
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
    {account && <DirectoryInspector key={account.id} id={inspectorId} label="Connection details" onClose={() => {
      selectedRow.current?.focus({ preventScroll: true })
      onSelect()
    }}
      heading={<div className={directory.identityText}><Heading level={3}>{account.label}</Heading></div>}
      status={<AccountStatus account={account} />}>
      <AccountFacts account={account} />
      {!account.revoked && <div className={styles.stack}>
        {!account.expired && !account.connected && prompt && <Text variant="muted" size="sm">Paste the prompt into your agent, then approve its connection in your browser.</Text>}
        <div className={cn(directory.actions, styles.inspectorActions)}>
          {account.expired
            ? <Button variant="primary" onClick={() => { setTtl('8'); setDialog('renew') }}>Renew access</Button>
            : <Button variant={account.connected ? 'secondary' : 'primary'} disabled={!prompt} onClick={copy}><CopySolidIcon size={14} />Copy agent prompt</Button>}
          <Button variant="destructive" onClick={() => setDialog('revoke')}>Revoke access</Button>
        </div>
      </div>}
      <RecentActivity account={account} refreshStatus={overview.refresh} />
    </DirectoryInspector>}
    {dialog === 'create' && <CreateServiceAccountDialog onClose={() => setDialog(null)} onCreate={async grant => {
      try {
        const result = await runStepUp(() => apiRequest(base, { method: 'POST', schema: IdSchema, body: grant }))
        onSelect(result.id)
        setDialog(null)
        overview.refresh()
      } catch (err) { report('Could not create CLI connection', err) }
    }} />}
    {dialog === 'renew' && account && !account.revoked && account.expired && <Dialog open size="sm" title="Renew access" onClose={() => { if (!busy) setDialog(null) }}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={renew}>Renew access</Button>
      </>}>
      <div className={styles.group}>
        <Text size="sm">Renew <strong>{account.label}</strong> with its existing permissions.</Text>
        <ServiceAccountLifetime value={ttl} onChange={setTtl} />
      </div>
    </Dialog>}
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
      {overview.loading && !overview.data ? <Text variant="muted">Loading connection…</Text> : valid ? <>
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
