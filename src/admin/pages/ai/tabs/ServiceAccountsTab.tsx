import { useEffect, useState } from 'react'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { apiRequest } from '@core/http'
import { Type } from '@core/utils/typeboxHelpers'
import type { CoreCapability } from '@core/capabilities'
import { SERVICE_CAPABILITIES, ServiceOverviewSchema, ServiceCodeSchema, type ServiceAccount } from '@core/serviceAccounts'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useLocation } from '@admin/lib/routing'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { hasCapability } from '@admin/access'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { CapabilityPicker, capabilityLabel } from '@admin/shared/CapabilityPicker'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { WorkspaceChoice, WorkspaceChoices } from '@admin/shared/SettingsWorkspace/WorkspaceChoices'
import { WorkspaceSection } from '@admin/shared/SettingsWorkspace/WorkspaceSection'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { pushToast } from '@ui/components/Toast'
import styles from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'
import layout from '@admin/shared/SettingsWorkspace/WorkspaceSection.module.css'
import consent from '../McpOAuthAuthorizePage.module.css'

const base = '/admin/api/cms/service-accounts'
const IdSchema = Type.Object({ id: Type.String() })
const expiryOptions = [
  { value: '1', label: '1 hour' }, { value: '8', label: '8 hours' }, { value: '24', label: '1 day' },
  { value: '168', label: '7 days' }, { value: '720', label: '30 days' },
]
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

export function ServiceAccountsTab() {
  const overview = useOverview()
  const user = useAuthenticatedAdminUser()
  const { runStepUp } = useStepUp()
  const [id, setId] = useState('')
  const [dialog, setDialog] = useState<'create' | 'revoke' | null>(null)
  const [label, setLabel] = useState('')
  const [ttl, setTtl] = useState('8')
  const allowed = SERVICE_CAPABILITIES.filter(c => hasCapability(user, c))
  const [selected, setSelected] = useState<Set<CoreCapability>>(() => new Set(allowed.filter(c => c === 'site.read')))
  const [busy, setBusy] = useState(false)
  const account = overview.data?.accounts.find(a => a.id === id) ?? overview.data?.accounts[0]
  const origin = overview.data?.origin
  const prompt = account && origin && overview.data ? agentPrompt(origin, account.id, overview.data.cliFilename) : ''
  const groups = [
    { title: 'Site and branches', capabilities: allowed.filter(c => c.startsWith('site.')) },
    { title: 'Content and tables', capabilities: allowed.filter(c => c.startsWith('data.') || c.startsWith('content.')) },
    { title: 'Media and settings', capabilities: allowed.filter(c => !/^(data|content|site)\./.test(c)) },
  ].filter(g => g.capabilities.length)

  async function submit() {
    setBusy(true)
    try {
      if (dialog === 'create') {
        const result = await runStepUp(() => apiRequest(base, { method: 'POST', schema: IdSchema,
          body: { label: label.trim(), ttlHours: Number(ttl), capabilities: [...selected] } }))
        setId(result.id)
        setLabel('')
      } else if (account) await apiRequest(base + '/' + account.id, { method: 'DELETE' })
      setDialog(null)
      overview.refresh()
    } catch (err) { report('Could not update service account', err) }
    finally { setBusy(false) }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast({ kind: 'success', title: 'Agent prompt copied' })
    } catch (err) { report('Select and copy the prompt below', err) }
  }
  return <WorkspaceSection title="Service accounts" actions={<Button variant="primary" disabled={!origin} onClick={() => {
      setLabel(''); setTtl('8'); setSelected(new Set(allowed.filter(c => c === 'site.read'))); setDialog('create')
    }}>Create service account</Button>}>
    {overview.error && <p role="alert">{overview.error}</p>}
    {overview.loading && <p role="status">Loading service accounts…</p>}
    {overview.data && !origin && <p>Set PUBLIC_ORIGIN to the HTTPS address of this installation to enable CLI connections.</p>}
    {overview.data?.accounts.length ? <WorkspaceChoices title="Your connectors">
      {overview.data.accounts.map(a => <WorkspaceChoice key={a.id} icon={<CodeIcon size={18} />} active={account?.id === a.id}
        label={a.label} description={status(a)} onSelect={() => setId(a.id)} />)}
    </WorkspaceChoices> : overview.data && <p>Give an external agent access to the CMS with selected permissions and an expiry.</p>}
    {account && <section className={layout.detailCard}>
      <h3>{account.label}</h3>
      <p>{status(account)} · Expires {new Date(account.expiresAt).toLocaleString()}</p>
      <p>{account.capabilities.map(capabilityLabel).join(' · ')}</p>
      {!account.revoked && !account.expired && <>
        <h4>Agent handoff</h4><pre className={styles.promptText}>{prompt}</pre>
        <div className={styles.settingsDetailActions}>
          <Button variant="primary" onClick={copy}>Copy agent prompt</Button>
          <Button variant="secondary" onClick={() => setDialog('revoke')}>Revoke access</Button>
        </div>
      </>}
    </section>}
    {dialog && <Dialog open onClose={() => { if (!busy) setDialog(null) }} title={dialog === 'create' ? 'Create service account' : 'Revoke access?'}
      size={dialog === 'create' ? 'xl' : 'sm'} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button>
        <Button variant="primary" disabled={busy || (dialog === 'create' && (!label.trim() || !selected.size))} onClick={submit}>
          {dialog === 'create' ? 'Create account' : 'Revoke access'}</Button></>}>
      {dialog === 'create' ? <div className={styles.providerSetupForm}>
        <label>Account name<Input value={label} maxLength={100} placeholder="Launch editor" onChange={e => setLabel(e.currentTarget.value)} /></label>
        <label>Expires after<Select value={ttl} options={expiryOptions} onChange={e => setTtl(e.currentTarget.value)} /></label>
        <p>These permissions apply across the installation, including main and any branches the account can access.</p>
        <CapabilityPicker groups={groups} selected={selected} onChange={setSelected} />
      </div> : <p>The CLI for {account?.label} will lose access immediately.</p>}
    </Dialog>}
  </WorkspaceSection>
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
    finally { setBusy(false) }
  }
  return <AdminPageLayout workspace="ai" mode="workspace"><div className={consent.pageBody}>
    <header className={consent.heading}><h1>Connect Instatic CLI</h1></header>
    {overview.loading ? <p>Loading account…</p> : valid ? <section className={consent.clientCard}>
      <h2>{account.label}</h2><p>Approve the request from your CLI on this machine. Match code <strong>{state.slice(0, 8)}</strong> with the terminal.</p>
      <p>Expires {new Date(account.expiresAt).toLocaleString()}</p><p>{account.capabilities.map(capabilityLabel).join(' · ')}</p>
      {account.connected && <p>Connecting this device replaces the previous CLI credential.</p>}
      <div className={consent.actions}><Button variant="secondary" disabled={busy} onClick={() => returnToCli({ error: 'access_denied' })}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={approve}>Authorize CLI</Button></div>
    </section> : <p role="alert">{overview.error ?? 'This request is invalid, expired, or belongs to another administrator.'}</p>}
  </div></AdminPageLayout>
}
