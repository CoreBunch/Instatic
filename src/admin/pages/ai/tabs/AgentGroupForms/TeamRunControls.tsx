import { useState } from 'react'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { apiRequest } from '@core/http'
import type { ServiceGroupRun, ServiceGroupRunCreatedSchema } from '@core/serviceAccounts'
import type { Static } from '@core/utils/typeboxHelpers'
import { capabilityLabel } from '@admin/shared/CapabilityPicker'
import { useStepUp } from '@admin/shared/StepUp'
import { Button } from '@ui/components/Button'
import { Code } from '@ui/components/Code'
import { Dialog } from '@ui/components/Dialog'
import { FormField } from '@ui/components/FormField'
import { Select } from '@ui/components/Select'
import { Text } from '@ui/components/Text'
import { pushToast } from '@ui/components/Toast'
import { CliIdentityIcon } from '../CliIdentityIcon'
import { reportGroupError, serviceAccountsPath } from './shared'
import styles from './AgentGroupForms.module.css'

type Invites = Static<typeof ServiceGroupRunCreatedSchema>['invites']
type RunMember = ServiceGroupRun['members'][number]

function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function buildPrompt(run: ServiceGroupRun, members: RunMember[], invites: Invites, origin: string, cliFilename: string, team: boolean) {
  const assignments = members.map(member => {
    const invite = invites.find(row => row.accountId === member.accountId)
    if (!invite) return ''
    const connect = 'INSTATIC_ENROLLMENT_KEY=' + shellQuote(invite.enrollmentKey) + ' instatic connect ' + shellQuote(origin) +
      ' --account ' + shellQuote(member.accountId) + ' --group-run ' + shellQuote(run.id)
    return [
      member.label + ' — ' + member.responsibility,
      'Permissions: ' + member.capabilities.map(capabilityLabel).join(', '),
      connect,
    ].join('\n')
  })
  const version = cliFilename.slice('instatic-cli-'.length, -'.tgz'.length)
  return [
    team ? 'Coordinate this Instatic team. Give each agent its own assignment and connection command.'
      : 'Complete your assignment on this Instatic branch.',
    'Branch: ' + run.branchId + '\nTask: ' + run.task,
    'Check instatic --version. If the CLI is missing or older than ' + version + ', ask before installing it with:\n' +
      'bun add --global ' + shellQuote(origin + serviceAccountsPath + '/' + cliFilename),
    ...assignments,
    team ? 'Start all connection commands concurrently. Send me each agent name and the verification code printed by its CLI, then wait for me to approve the team.'
      : 'Send me your agent name and the verification code printed by the CLI. Keep the command running while I approve the team.',
    'Keep enrollment keys private. After approval, run instatic whoami --account ID with the account ID from your command. Use that account on every command and --branch ' +
      shellQuote(run.branchId ?? '') + ' for branch operations. Run instatic --help for syntax, then report your work.',
  ].join('\n\n')
}

function TeamPromptDialog({ run, invites, origin, cliFilename, onClose }: {
  run: ServiceGroupRun
  invites: Invites
  origin: string
  cliFilename: string
  onClose: () => void
}) {
  const [single, setSingle] = useState(false)
  const [choice, setChoice] = useState('')
  const available = run.members.filter(member => invites.some(invite => invite.accountId === member.accountId) && !member.challenge)
  const agent = available.find(member => member.accountId === choice) ?? available[0]
  const prompt = buildPrompt(run, single && agent ? [agent] : available, invites, origin, cliFilename, !single)

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      pushToast({ kind: 'success', title: single ? 'Agent prompt copied' : 'Team prompt copied' })
    } catch (err) { reportGroupError('Could not copy the prompt. Select the text to copy it manually.', err) }
  }

  return <Dialog open size="xl" title="Connect your agents" onClose={onClose}
    footer={<>
      <Button variant="ghost" onClick={() => setSingle(!single)}>{single ? 'Team prompt' : 'Individual prompts'}</Button>
      <Button variant="primary" onClick={copy} disabled={!available.length}><CopySolidIcon size={14} />{single ? 'Copy agent prompt' : 'Copy team prompt'}</Button>
    </>}>
    <div className={styles.stack}>
      <Text variant="muted">{single ? 'Paste this prompt into the selected agent.' : 'Paste the team prompt into your orchestrator.'} Each connection command contains a single-use enrollment key.</Text>
      {single && <FormField label="Agent" htmlFor="prompt-agent">
        <Select id="prompt-agent" value={agent?.accountId ?? ''} options={available.map(member => ({ value: member.accountId, label: member.label }))}
          onChange={event => setChoice(event.currentTarget.value)} />
      </FormField>}
      <Code className={styles.prompt}>{prompt}</Code>
    </div>
  </Dialog>
}

export function TeamRunControls({ run, origin, cliFilename, invites, onChange }: {
  run: ServiceGroupRun
  origin: string | null
  cliFilename: string
  invites?: Invites
  onChange: () => void
}) {
  const { runStepUp } = useStepUp()
  const [dialog, setDialog] = useState<'prompt' | 'review' | null>(null)
  const [busy, setBusy] = useState(false)
  const requested = run.members.flatMap(member => member.challenge ? [{ accountId: member.accountId, challenge: member.challenge }] : [])
  const ready = requested.length === run.members.length && requested.length > 0
  const pendingInvite = invites?.some(invite => run.members.some(member => member.accountId === invite.accountId && !member.challenge))
  if (run.revoked || run.approved || !run.branchId) return null

  async function approve() {
    if (!ready || busy) return
    setBusy(true)
    try {
      await runStepUp(() => apiRequest(serviceAccountsPath + '/runs/' + encodeURIComponent(run.id) + '/approve', {
        method: 'POST', body: { members: requested },
      }))
      setDialog(null)
      pushToast({ kind: 'success', title: 'Team access approved' })
      onChange()
    } catch (err) {
      reportGroupError('Could not approve team access', err)
      onChange()
    } finally { setBusy(false) }
  }

  return <>
    {pendingInvite && origin && <Button variant="primary" onClick={() => setDialog('prompt')}>Team prompt</Button>}
    <Button variant={ready ? 'primary' : 'secondary'} onClick={() => setDialog('review')}>Review requests ({requested.length}/{run.members.length})</Button>
    {dialog === 'prompt' && origin && invites && (pendingInvite
      ? <TeamPromptDialog run={run} origin={origin} cliFilename={cliFilename} invites={invites} onClose={() => setDialog(null)} />
      : <Dialog open title="All agents have requested access" onClose={() => setDialog(null)}
          footer={<Button variant="primary" onClick={() => setDialog('review')}>Review requests</Button>}>
          <Text>Compare their verification codes and approve the team.</Text>
        </Dialog>)}
    {dialog === 'review' && <Dialog open size="xl" title="Approve team access" onClose={() => { if (!busy) setDialog(null) }}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button>
        <Button variant="primary" disabled={!ready} busy={busy} onClick={approve}>Approve {run.members.length} {run.members.length === 1 ? 'agent' : 'agents'}</Button>
      </>}>
      <div className={styles.stack}>
        <Text variant="muted">Match each code with the one in your orchestrator or agent terminal.</Text>
        <dl className={styles.facts}>
          <div><dt>Branch</dt><dd>{run.branchId}</dd></div>
          <div><dt>Access expires</dt><dd><time dateTime={run.expiresAt}>{new Date(run.expiresAt).toLocaleString()}</time></dd></div>
        </dl>
        <ul className={styles.roster}>{run.members.map(member =>
          <li key={member.accountId} className={styles.role}>
            <CliIdentityIcon agent={member.label} />
            <div className={styles.identity}>
              <Text variant="strong">{member.label}</Text>
              <Text variant="muted" size="sm">{member.capabilities.map(capabilityLabel).join(' · ')}</Text>
            </div>
            {member.challenge ? <code className={styles.verification}>{member.challenge.slice(0, 8)}</code>
              : <Text variant="muted" size="sm">Waiting for request</Text>}
          </li>)}</ul>
        {!ready && !pendingInvite && <Text variant="muted" size="sm">Use the prompts you copied when creating this run. If you need new enrollment keys, end this run and start another.</Text>}
      </div>
    </Dialog>}
  </>
}
