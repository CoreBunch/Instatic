import { useRef, useState } from 'react'
import { SERVICE_CAPABILITIES } from '@core/serviceAccounts'
import type { CoreCapability } from '@core/capabilities'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { hasCapability } from '@admin/access'
import { CAPABILITY_META } from '@admin/shared/CapabilityPicker'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { Dialog } from '@ui/components/Dialog'
import { FormField } from '@ui/components/FormField'
import { Input } from '@ui/components/Input'
import { Section } from '@ui/components/Section'
import { Select } from '@ui/components/Select'
import { Text } from '@ui/components/Text'
import styles from './ServiceAccounts.module.css'

const expiryOptions = [
  { value: '1', label: '1 hour' }, { value: '8', label: '8 hours' }, { value: '24', label: '1 day' },
  { value: '168', label: '7 days' }, { value: '720', label: '30 days' },
]
type Grant = { label: string; ttlHours: number; capabilities: CoreCapability[] }

export function CreateServiceAccountDialog({ onClose, onCreate }: {
  onClose: () => void
  onCreate: (grant: Grant) => Promise<void>
}) {
  const user = useAuthenticatedAdminUser()
  const allowed = SERVICE_CAPABILITIES.filter(c => hasCapability(user, c))
  const groups = [
    { title: 'Site and branches', caps: allowed.filter(c => c.startsWith('site.')) },
    { title: 'Content and tables', caps: allowed.filter(c => /^(content|data)\./.test(c)) },
    { title: 'Media and settings', caps: allowed.filter(c => !/^(site|content|data)\./.test(c)) },
  ].filter(group => group.caps.length)
  const [selected, setSelected] = useState<Set<CoreCapability>>(() => new Set(allowed.filter(c => c === 'site.read')))
  const [label, setLabel] = useState('')
  const [ttl, setTtl] = useState('8')
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  function toggle(cap: CoreCapability, checked: boolean) {
    setSelected(current => {
      const next = new Set(current)
      if (checked) next.add(cap)
      else next.delete(cap)
      return next
    })
  }
  return <Dialog open size="lg" initialFocusRef={nameInput} title="Create service account" onClose={() => { if (!busy) onClose() }}
    footer={<>
      <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit" form="service-account-form" disabled={busy || !label.trim() || !selected.size}>
        {busy ? 'Creating…' : 'Create account'}
      </Button>
    </>}>
    <form id="service-account-form" className={styles.stack} onSubmit={async event => {
      event.preventDefault()
      if (busy || !label.trim() || !selected.size) return
      setBusy(true)
      await onCreate({ label: label.trim(), ttlHours: Number(ttl), capabilities: [...selected] })
      setBusy(false)
    }}>
      <div className={styles.fields}>
        <FormField label="Account name" htmlFor="service-account-name">
          <Input ref={nameInput} id="service-account-name" value={label} maxLength={100} placeholder="e.g. Content editor" onChange={event => setLabel(event.currentTarget.value)} />
        </FormField>
        <FormField label="Expires after" htmlFor="service-account-expiry">
          <Select id="service-account-expiry" value={ttl} options={expiryOptions} onChange={event => setTtl(event.currentTarget.value)} />
        </FormField>
      </div>
      <div className={styles.group}>
        <Text variant="strong">Permissions</Text>
        <Text variant="muted" size="sm">Applies to the whole site, including main.</Text>
        {groups.map((group, index) => <Section key={group.title} title={group.title} flush chevron defaultOpen={index === 0}
          meta={group.caps.filter(c => selected.has(c)).length || undefined}>
          <div className={styles.checks}>
            {group.caps.map(cap => <FormField key={cap} layout="inline-start"
              description={cap === 'site.branches.manage' ? 'Can merge changes into main.' : undefined}
              label={<span title={CAPABILITY_META[cap].description}>{CAPABILITY_META[cap].label}</span>}>
              <Checkbox checked={selected.has(cap)} onCheckedChange={checked => toggle(cap, checked)} />
            </FormField>)}
          </div>
        </Section>)}
      </div>
    </form>
  </Dialog>
}
