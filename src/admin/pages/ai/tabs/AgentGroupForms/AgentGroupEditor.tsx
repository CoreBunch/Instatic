import { useRef, useState } from 'react'
import type { CoreCapability } from '@core/capabilities'
import { apiRequest } from '@core/http'
import { GROUP_CAPABILITIES, type ServiceGroup } from '@core/serviceAccounts'
import { Type } from '@core/utils/typeboxHelpers'
import { hasCapability } from '@admin/access'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { CapabilityPicker } from '@admin/shared/CapabilityPicker'
import { useStepUp } from '@admin/shared/StepUp'
import { cn } from '@ui/cn'
import { Alert } from '@ui/components/Alert'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { FormField } from '@ui/components/FormField'
import { Heading } from '@ui/components/Heading'
import { Input, Textarea } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { Text } from '@ui/components/Text'
import layout from '@admin/shared/SettingsWorkspace/WorkspaceSection.module.css'
import { CliIdentityIcon } from '../CliIdentityIcon'
import { reportGroupError, serviceAccountsPath, type GroupMember } from './shared'
import styles from './AgentGroupForms.module.css'

const GroupIdSchema = Type.Object({ id: Type.String() })
const presets: GroupMember[] = [
  { label: 'Designer', responsibility: 'Design the page layout and check that it works at mobile and desktop sizes.', capabilities: ['site.read', 'site.style.edit'] },
  { label: 'Writer', responsibility: 'Write and edit the page copy. Check headings, links and calls to action.', capabilities: ['site.read', 'site.content.edit'] },
  { label: 'Reviewer', responsibility: 'Inspect the branch preview, check the changes against the task and report findings to the team.', capabilities: ['site.read'] },
]
const customMember: GroupMember = { label: '', responsibility: '', capabilities: ['site.read'] }

function MemberDialog({ initial, existingLabels, available, onSave, onClose }: {
  initial?: GroupMember
  existingLabels: string[]
  available: readonly GroupMember['capabilities'][number][]
  onSave: (member: GroupMember) => void
  onClose: () => void
}) {
  const nameInput = useRef<HTMLInputElement>(null)
  const [member, setMember] = useState(initial ?? customMember)
  const [preset, setPreset] = useState('')
  const selected = new Set<CoreCapability>(available.filter(cap => member.capabilities.includes(cap)))
  const name = member.label.trim()
  const duplicate = existingLabels.some(label => label.toLowerCase() === name.toLowerCase())
  const valid = name && member.responsibility.trim() && selected.size > 0 && !duplicate
  return <Dialog open size="xl" title={initial ? 'Edit agent' : 'Add agent'} initialFocusRef={nameInput} onClose={onClose}
    footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit" form="group-agent-form" disabled={!valid}>{initial ? 'Save agent' : 'Add to team'}</Button>
    </>}>
    <form id="group-agent-form" className={styles.stack} onSubmit={event => {
      event.preventDefault()
      if (valid) onSave({ label: name, responsibility: member.responsibility.trim(), capabilities: available.filter(cap => selected.has(cap)) })
    }}>
      {!initial && <FormField label="Start from" htmlFor="agent-template">
        <Select id="agent-template" value={preset} options={[
          { value: '', label: 'Custom agent' }, ...presets.map(p => ({ value: p.label, label: p.label })),
        ]} onChange={event => {
          const label = event.currentTarget.value
          setPreset(label)
          setMember(presets.find(p => p.label === label) ?? customMember)
        }} />
      </FormField>}
      <FormField label="Agent name" htmlFor="agent-name">
        <Input id="agent-name" ref={nameInput} required value={member.label} maxLength={100} placeholder="e.g. Accessibility reviewer"
          invalid={duplicate} aria-describedby={duplicate ? 'agent-name-error' : undefined}
          onChange={event => setMember({ ...member, label: event.currentTarget.value })} />
        {duplicate && <span id="agent-name-error" role="alert" className={styles.error}>An agent in this group already has that name.</span>}
      </FormField>
      <FormField label="Responsibilities" htmlFor="agent-responsibilities">
        <Textarea id="agent-responsibilities" required rows={3} maxLength={2000} value={member.responsibility}
          placeholder="What should this agent do on the branch?"
          onChange={event => setMember({ ...member, responsibility: event.currentTarget.value })} />
      </FormField>
      <CapabilityPicker title="Branch permissions" groups={[{ title: 'Branch access', capabilities: available }]} selected={selected}
        onChange={next => setMember({ ...member, capabilities: available.filter(cap => next.has(cap)) })} />
    </form>
  </Dialog>
}

export function AgentGroupEditor({ group, onCancel, onSaved }: {
  group?: ServiceGroup
  onCancel: () => void
  onSaved: (id: string) => void
}) {
  const user = useAuthenticatedAdminUser()
  const { runStepUp } = useStepUp()
  const available = GROUP_CAPABILITIES.filter(cap => hasCapability(user, cap))
  const sample = presets.map(member => ({ ...member, capabilities: member.capabilities.filter(cap => available.some(allowed => allowed === cap)) }))
  const [label, setLabel] = useState(group?.label ?? '')
  const [members, setMembers] = useState<GroupMember[]>(group?.members ?? [])
  const [editing, setEditing] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const canSave = label.trim() && members.length > 0 && members.every(member =>
    member.capabilities.every(cap => available.some(allowed => allowed === cap)))
  const title = group ? 'Edit agent group' : 'Create agent group'

  async function save() {
    if (!canSave || busy) return
    setBusy(true)
    try {
      const id = group ? '/' + encodeURIComponent(group.id) : ''
      const result = await runStepUp(() => apiRequest(serviceAccountsPath + '/groups' + id, {
        method: group ? 'PUT' : 'POST', body: { label: label.trim(), members }, schema: GroupIdSchema,
      }))
      onSaved(result.id)
    } catch (err) { reportGroupError('Could not save agent group', err) }
    finally { setBusy(false) }
  }

  return <section aria-label={title} className={cn(layout.section, styles.editor)}>
    <header className={layout.sectionHeader}><Heading level={1}>{title}</Heading></header>
    <form className={styles.stack} onSubmit={event => { event.preventDefault(); void save() }}>
      <div className={cn(layout.detailCard, styles.stack)}>
        <FormField label="Group name" htmlFor="agent-group-name">
          <Input id="agent-group-name" required value={label} maxLength={100} placeholder="e.g. Launch team"
            disabled={busy} onChange={event => setLabel(event.currentTarget.value)} />
        </FormField>
        <section aria-label="Team members">
          <header className={styles.sectionHeader}>
            <Heading level={2}>Team members</Heading>
            <Button variant="secondary" size="sm" disabled={busy || members.length >= 16 || !available.length}
              onClick={() => setEditing(members.length)}>Add agent</Button>
          </header>
          {members.length > 0 ? <ul className={styles.roster}>{members.map((member, index) =>
            <li key={member.label} className={styles.role}>
              <CliIdentityIcon agent={member.label} />
              <div className={styles.identity}>
                <Text variant="strong">{member.label}</Text><Text variant="muted">{member.responsibility}</Text>
                {member.capabilities.some(cap => !available.some(allowed => allowed === cap)) &&
                  <Text variant="muted" size="sm">Edit this agent to select permissions you can grant.</Text>}
              </div>
              <div className={styles.actions}>
                <Button variant="ghost" size="sm" aria-label={'Edit ' + member.label} disabled={busy} onClick={() => setEditing(index)}>Edit</Button>
                <Button variant="ghost" size="sm" dangerHover aria-label={'Remove ' + member.label} disabled={busy}
                  onClick={() => setMembers(members.filter((_, i) => i !== index))}>Remove</Button>
              </div>
            </li>)}</ul> : <EmptyState variant="card" plain compact title="Who should work on this site?"
            description="Add your first agent or start with a designer, writer and reviewer."
            action={sample.every(member => member.capabilities.length > 0) &&
              <Button variant="secondary" size="sm" onClick={() => setMembers(sample)}>Use sample team</Button>} />}
          {!available.length && <Alert tone="warning">Your role needs at least one branch permission to create an agent.</Alert>}
        </section>
      </div>
      <div className={styles.footer}>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy} disabled={!canSave}>{group ? 'Save group' : 'Create group'}</Button>
      </div>
    </form>
    {editing !== null && <MemberDialog initial={members[editing]} available={available}
      existingLabels={members.filter((_, i) => i !== editing).map(member => member.label)}
      onClose={() => setEditing(null)} onSave={member => {
        const next = [...members]
        next[editing] = member
        setMembers(next)
        setEditing(null)
      }} />}
  </section>
}
