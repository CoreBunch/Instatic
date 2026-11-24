import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRightIcon } from 'pixel-art-icons/icons/chevron-right'
import { CliIdentityIcon } from './CliIdentityIcon'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { apiRequest } from '@core/http'
import { ServiceOverviewSchema, ServiceCodeSchema, ServiceGroupRunCreatedSchema, ServiceGroupOverviewSchema, type ServiceAccount, type ServiceGroupRun } from '@core/serviceAccounts'
import { getErrorMessage } from '@core/utils/errorMessage'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { useLocation, useNavigate } from '@admin/lib/routing'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { capabilityLabel } from '@admin/shared/CapabilityPicker'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { cn } from '@ui/cn'
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Heading } from '@ui/components/Heading'
import { Text } from '@ui/components/Text'
import { pushToast } from '@ui/components/Toast'
import { ConnectionDetail } from './ConnectionDetail'
import { AgentGroupEditor, StartTeamRunDialog, TeamRunControls } from './AgentGroupForms'
import { FormField } from '@ui/components/FormField'
import { Select } from '@ui/components/Select'
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
    'If it is missing or older than ' + filename.slice('instatic-cli-'.length, -'.tgz'.length) + ', ask me for approval before installing this version:',
    'bun add --global ' + quote(origin + base + '/' + filename),
    'Then run this command and wait for me to approve the connection in my browser:',
    'instatic connect ' + quote(origin) + ' --account ' + account,
    'Use --account ' + account + ' on subsequent commands. Run instatic whoami to check your permissions. Use instatic api lookup to find an operation, then instatic api describe METHOD PATH with the returned method and path to see its inputs and command. For page edits, use instatic canvas read with page IDs or /slugs and --branch ID to get revisions together. Use the revision from a save or read with instatic canvas edit. Use instatic canvas inspect PAGE --branch ID --viewport WIDTHxHEIGHT and open the PNG to check visual changes. Use instatic canvas modules for module schemas and instatic canvas collection TABLE --branch ID for a bound listing example. Test search, detail links and scripts with instatic visit /PATH --branch ID. Run instatic --help for syntax. Report the result here.',
  ].join('\n')
}

const expires = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function AccountFacts({ account }: { account: ServiceAccount }) {
  return <dl className={directory.facts}>
    <div><dt>Expires</dt><dd><time dateTime={account.expiresAt}>{expires.format(new Date(account.expiresAt))}</time></dd></div>
    <div><dt>Permissions</dt><dd>{account.capabilities.map(capabilityLabel).join(', ')}</dd></div>
  </dl>
}

function runState(run: ServiceGroupRun | undefined) {
  if (!run) return 'Ready to run'
  if (run.revoked) return 'Run ended'
  if (run.expired) return 'Expired'
  if (!run.approved) return 'Awaiting approval'
  return 'Run active'
}
function DirectorySection({ title, description, create, rows, group, open }: {
  title: string; description: string; create: ReactNode; group?: boolean
  rows: { id: string; label: string; summary: string; status: string }[]; open: (id: string) => void
}) {
  return <section aria-label={title} className={cn(layout.detailCard, styles.directoryCard)}>
    <div className={layout.sectionHeader}>
      <div><Heading level={3}>{title}</Heading><Text variant="muted" size="sm">{description}</Text></div>
      {create}
    </div>
    {rows.length > 0 && <ul className={styles.directoryList}>{rows.map(row => (
      <li key={row.id}>
        <Button variant="ghost" align="start" fullWidth className={styles.directoryRow}
          aria-labelledby={row.id + '-label'} aria-describedby={row.id + '-summary ' + row.id + '-status'} onClick={() => open(row.id)}>
          {group ? <CliIdentityIcon group /> : <CliIdentityIcon agent={row.label} />}
          <span className={cn(directory.identityText, styles.identity)}>
            <strong id={row.id + '-label'}>{row.label}</strong>
            <small id={row.id + '-summary'}>{row.summary}</small>
          </span>
          <span className={styles.directoryStatus} id={row.id + '-status'}>{row.status}</span>
          <ChevronRightIcon size={14} aria-hidden="true" />
        </Button>
      </li>
    ))}</ul>}
  </section>
}

export function ServiceAccountsTab({ initialAccount }: { initialAccount?: string | null }) {
  const overview = useOverview()
  const teams = useAsyncResource(signal => apiRequest(base + '/groups', { schema: ServiceGroupOverviewSchema, signal }), [])
  const { runStepUp } = useStepUp()
  const query = new URLSearchParams(useLocation().search)
  const pairing = query.get('pairing')
  const navigate = useNavigate()
  const id = pairing ? '' : query.get('group') ?? initialAccount ?? ''
  const [dialog, setDialog] = useState<'create' | 'revoke' | 'create-group' | 'edit-group' | 'start' | 'end' | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<Static<typeof ServiceGroupRunCreatedSchema> | null>(null)
  const [selectedRun, setSelectedRun] = useState('')
  const account = overview.data?.accounts.find(a => a.id === id)
  const group = teams.data?.groups.find(g => g.id === id)
  const runs = teams.data?.runs.filter(r => r.groupId === id) ?? []
  const run = runs.find(r => r.id === selectedRun) ?? runs[0]
  const activeRun = runs.find(r => !r.revoked && !r.expired)
  const live = !!run && !run.revoked && !run.expired
  const { refresh: refreshTeams } = teams
  const { refresh: refreshAccounts } = overview
  useEffect(() => {
    if (!id) return
    const timer = window.setInterval(() => {
      if (!document.hidden) { refreshTeams(); refreshAccounts() }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [id, refreshTeams, refreshAccounts])

  const origin = overview.data?.origin
  const active = account && !account.revoked && !account.expired
  function open(next: string) {
    const key = next.startsWith('svc_') ? 'service-account' : 'group'
    navigate(next ? '/admin/ai?' + key + '=' + encodeURIComponent(next) : '/admin/ai?cli')
    setSelectedRun(''); setDialog(null)
  }
  async function copy() {
    if (!account || !origin || !overview.data) return
    try {
      await navigator.clipboard.writeText(agentPrompt(origin, account.id, overview.data.cliFilename))
      pushToast({ kind: 'success', title: 'Agent prompt copied' })
    } catch (err) { report('Could not copy the agent prompt', err) }
  }
  async function closeAccess() {
    if (!account && !run) return
    setBusy(true)
    try {
      await apiRequest(account ? base + '/' + account.id : base + '/runs/' + run!.id, { method: 'DELETE' })
      setDialog(null); refreshAccounts(); refreshTeams()
    } catch (err) { report('Could not close access', err) }
    setBusy(false)
  }
  if (dialog === 'create-group' || dialog === 'edit-group') {
    return <AgentGroupEditor group={dialog === 'edit-group' ? group : undefined}
      onCancel={() => setDialog(null)} onSaved={groupId => { open(groupId); refreshTeams() }} />
  }
  return <div className={styles.stack}>
    {pairing === 'failed' && <Alert tone="danger">Connection failed. Run the CLI connect command again.</Alert>}
    {pairing === 'declined' && <Text variant="muted">CLI connection request declined.</Text>}
    {(overview.error || teams.error) && <Alert tone="danger">{overview.error ?? teams.error}</Alert>}
    {overview.data && !origin && <Alert tone="warning">Configure PUBLIC_ORIGIN to enable CLI connections.</Alert>}
    {account ? <ConnectionDetail title={account.label} type="Individual connection" status={status(account)}
      scope="Entire site" expiry={account.expiresAt} agents={[account]} activityId={account.id} live={Boolean(active)}
      onBack={() => open('')} guidance={active && !account.connected && <Text variant="muted">Paste the prompt into your agent, then approve its connection in your browser.</Text>}
      actions={active && <><Button variant="primary" disabled={!origin} onClick={copy}><CopySolidIcon size={14}/>Copy agent prompt</Button>
        <Button variant="secondary" tone="danger" onClick={() => setDialog('revoke')}>Revoke access</Button></>} />
    : group ? <ConnectionDetail title={group.label} type="Agent group" status={runState(run)} scope={run ? (run.branchId ? 'Branch · ' + run.branchId : 'Deleted branch') : 'Set when starting a run'}
      expiry={run?.expiresAt} agents={run?.members ?? group.members} task={run?.task} activityId={run?.id} live={live} onBack={() => open('')}
      history={runs.length > 1 && <FormField label="Run" htmlFor="cli-run-history"><Select id="cli-run-history" value={run?.id ?? ''} options={runs.map(r => ({ value:r.id, label:(r.branchId ?? 'Deleted branch')+' · '+runState(r)+' · '+expires.format(new Date(r.expiresAt)) }))} onChange={e=>setSelectedRun(e.currentTarget.value)}/></FormField>}
      actions={<>{!activeRun && <Button variant="primary" disabled={!origin} onClick={() => setDialog('start')}>Start run</Button>}
        {live && origin && overview.data && <TeamRunControls run={run} origin={origin} cliFilename={overview.data.cliFilename} invites={created?.run.id === run.id ? created.invites : []} onChange={refreshTeams}/>}
        {run?.approved && run.branchId && <Button variant={live ? 'primary' : 'secondary'} onClick={() => navigate('/admin/branches/' + encodeURIComponent(run.branchId!) + '/review?branch=' + encodeURIComponent(run.branchId!))}>Open branch review</Button>}
        <Button variant="secondary" onClick={() => setDialog('edit-group')}>Edit group</Button>
        {live && <Button variant="secondary" tone="danger" onClick={() => setDialog('end')}>End run</Button>}</>} />
    : <><Heading level={2}>CLI connections</Heading>
      <div className={styles.directoryGrid}>
      <DirectorySection title="Individual connections" description="Give one external agent access to this site."
        create={<Button variant="primary" disabled={!origin} onClick={() => setDialog('create')}>Create CLI connection</Button>}
        rows={(overview.data?.accounts ?? []).map(a=>({ ...a, summary:a.capabilities.length+(a.capabilities.length === 1 ? ' permission' : ' permissions'), status:status(a) }))} open={open}/>
      <DirectorySection group title="Agent groups" description="Run a team together on one branch."
        create={<Button variant="secondary" disabled={!origin} onClick={() => setDialog('create-group')}>Create group</Button>}
        rows={(teams.data?.groups ?? []).map(g=>({ ...g, summary:g.members.map(m=>m.label).join(' · '), status:runState(teams.data?.runs.find(r=>r.groupId===g.id)) }))} open={open}/></div></>}
    {dialog === 'create' && <CreateServiceAccountDialog onClose={() => setDialog(null)} onCreate={async grant => {
      try {
        const result = await runStepUp(() => apiRequest(base, { method:'POST', schema:IdSchema, body:grant }))
        open(result.id); refreshAccounts()
      } catch (err) { report('Could not create CLI connection', err) }
    }}/>}

    {dialog === 'start' && group && <StartTeamRunDialog group={group} onClose={()=>setDialog(null)} onCreated={result=>{
      setCreated(result); setSelectedRun(result.run.id); setDialog(null); refreshTeams()
    }}/>}
    {(dialog==='revoke'||dialog==='end') && <Dialog open tone="danger" size="sm" title={account?'Revoke access?':'End run?'} onClose={()=>{if(!busy)setDialog(null)}}
      footer={<><Button variant="secondary" disabled={busy} onClick={()=>setDialog(null)}>Cancel</Button>
        <Button variant="destructive" busy={busy} onClick={closeAccess}>{account?'Revoke access':'End run'}</Button></>}>
      <Text>{account?account.label+' will lose CLI access immediately.':'All agents in this run will lose access. Its review and activity stay available.'}</Text></Dialog>}
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
