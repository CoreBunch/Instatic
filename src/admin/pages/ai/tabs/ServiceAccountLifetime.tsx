import { useId } from 'react'
import { FormField } from '@ui/components/FormField'
import { Select } from '@ui/components/Select'

const expiryOptions = [
  { value: '1', label: '1 hour' }, { value: '8', label: '8 hours' }, { value: '24', label: '1 day' },
  { value: '168', label: '7 days' }, { value: '720', label: '30 days' },
]

export function ServiceAccountLifetime({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId()
  return <FormField label="Expires after" htmlFor={id}>
    <Select id={id} value={value} options={expiryOptions} onChange={event => onChange(event.currentTarget.value)} />
  </FormField>
}
