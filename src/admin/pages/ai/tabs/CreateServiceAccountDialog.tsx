import { useRef, useState } from 'react'
import { OWNER_ONLY_CAPABILITY_SET, type CoreCapability } from '@core/capabilities'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { hasCapability } from '@admin/access'
import { CAPABILITY_GROUPS, CapabilityPicker } from '@admin/shared/CapabilityPicker'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FormField } from '@ui/components/FormField'
import { Input } from '@ui/components/Input'
import { ServiceAccountLifetime } from './ServiceAccountLifetime'
import { Text } from '@ui/components/Text'
import styles from './ServiceAccounts.module.css'

type Grant = { label: string; ttlHours: number; capabilities: CoreCapability[] }

export function CreateServiceAccountDialog({ onClose, onCreate }: {
  onClose: () => void
  onCreate: (grant: Grant) => Promise<void>
}) {
  const user = useAuthenticatedAdminUser()
  const groups = CAPABILITY_GROUPS.map(group => ({
    title: group.title,
    capabilities: group.capabilities.filter(cap => hasCapability(user, cap)),
  })).filter(group => group.capabilities.length)
  const [selected, setSelected] = useState<Set<CoreCapability>>(() => new Set(hasCapability(user, 'site.read') ? ['site.read'] : []))
  const [label, setLabel] = useState('')
  const [ttl, setTtl] = useState('8')
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)

  return <Dialog open size="xl" initialFocusRef={nameInput} title="Create CLI connection" onClose={() => { if (!busy) onClose() }}
    footer={<>
      <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit" form="service-account-form" disabled={busy || !label.trim() || !selected.size}>
        {busy ? 'Creating…' : 'Create connection'}
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
        <FormField label="Connection name" htmlFor="service-account-name">
          <Input ref={nameInput} id="service-account-name" value={label} maxLength={100} placeholder="e.g. Content editor" onChange={event => setLabel(event.currentTarget.value)} />
        </FormField>
        <ServiceAccountLifetime value={ttl} onChange={setTtl} />
      </div>
      <div className={styles.group}>
        <Text variant="muted" size="sm">Permissions apply across the site, including main.</Text>
        <CapabilityPicker title="Permissions" groups={groups} disabledCapabilities={OWNER_ONLY_CAPABILITY_SET} selected={selected} onChange={setSelected} />
      </div>
    </form>
  </Dialog>
}
