import { useState } from 'react'
import { canActOnBranch, isMainBranch } from '@core/branches'
import { apiRequest } from '@core/http'
import { listCmsBranches } from '@core/persistence'
import { ServiceGroupRunCreatedSchema, type ServiceGroup } from '@core/serviceAccounts'
import type { Static } from '@core/utils/typeboxHelpers'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useStepUp } from '@admin/shared/StepUp'
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FormField } from '@ui/components/FormField'
import { Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Text } from '@ui/components/Text'
import { reportGroupError, serviceAccountsPath } from './shared'
import styles from './AgentGroupForms.module.css'

const durations = [
  { value: '1', label: '1 hour' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '24', label: '1 day' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
]

export function StartTeamRunDialog({ group, onClose, onCreated }: {
  group: ServiceGroup
  onClose: () => void
  onCreated: (created: Static<typeof ServiceGroupRunCreatedSchema>) => void
}) {
  const user = useAuthenticatedAdminUser()
  const { runStepUp } = useStepUp()
  const branches = useAsyncResource(listCmsBranches, [], { fallbackError: 'Could not load branches.' })
  const options = (branches.data ?? []).filter(branch => !isMainBranch(branch.id) && canActOnBranch(user, branch))
    .map(branch => ({ value: branch.id, label: branch.name }))
  const [choice, setChoice] = useState('')
  const branchId = choice || options[0]?.value || ''
  const [duration, setDuration] = useState('1')
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const canStart = branchId && task.trim() && !branches.error && !branches.loading

  async function create() {
    if (!canStart || busy) return
    setBusy(true)
    try {
      const created = await runStepUp(() => apiRequest(serviceAccountsPath + '/groups/' + encodeURIComponent(group.id) + '/runs', {
        method: 'POST', body: { branchId, ttlHours: Number(duration), task: task.trim() }, schema: ServiceGroupRunCreatedSchema,
      }))
      onCreated(created)
    } catch (err) { reportGroupError('Could not start team run', err) }
    finally { setBusy(false) }
  }

  return <Dialog open size="lg" title="Start a team run" loading={branches.loading && !branches.data}
    onClose={() => { if (!busy) onClose() }} footer={<>
      <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit" form="start-team-run" disabled={!canStart} busy={busy}>Create run</Button>
    </>}>
    <form id="start-team-run" className={styles.stack} onSubmit={event => { event.preventDefault(); void create() }}>
      <Text variant="muted">Set the branch, task and access duration for <strong>{group.label}</strong>.</Text>
      {branches.error ? <Alert tone="danger">{branches.error} <Button variant="secondary" size="sm" onClick={branches.refresh}>Retry</Button></Alert>
        : !options.length && <Alert tone="warning">Create a branch in the Site workspace, or ask a branch manager to start this run.</Alert>}
      <div className={styles.fields}>
        <FormField label="Branch" htmlFor="team-branch">
          <Select id="team-branch" value={branchId} options={options} disabled={busy || !options.length}
            placeholder="Choose a branch" onChange={event => setChoice(event.currentTarget.value)} />
        </FormField>
        <FormField label="Expires after" htmlFor="team-duration">
          <Select id="team-duration" value={duration} options={durations} disabled={busy}
            onChange={event => setDuration(event.currentTarget.value)} />
        </FormField>
      </div>
      <FormField label="Task" htmlFor="team-task">
        <Textarea id="team-task" required rows={4} value={task} maxLength={4000} disabled={busy}
          placeholder="What should the team accomplish on this branch?" onChange={event => setTask(event.currentTarget.value)} />
      </FormField>
    </form>
  </Dialog>
}
