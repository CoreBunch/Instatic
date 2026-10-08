import { useId, useState } from 'react'
import { parseResourceOrigin } from '@core/site-runtime'
import { Input } from '@ui/components/Input'
import styles from './ResourceOriginsControl.module.css'

interface ResourceOriginsControlProps {
  label: string
  origins: string[]
  onChange: (origins: string[]) => void
}

export function ResourceOriginsControl({ label, origins, onChange }: ResourceOriginsControlProps) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState(false)
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <Input
        id={id}
        aria-label={`Allowed ${label.toLowerCase()} origins`}
        aria-invalid={error}
        aria-describedby={error ? `${id}-error` : undefined}
        fieldSize="xs"
        placeholder="https://provider.example"
        value={draft ?? origins.join(', ')}
        onChange={(event) => { setDraft(event.target.value); setError(false) }}
        onBlur={(event) => {
          const entries = event.target.value.split(',').map((entry) => entry.trim()).filter(Boolean)
          const parsed = entries.map(parseResourceOrigin)
          if (parsed.some((origin) => origin === null)) { setError(true); return }
          onChange([...new Set(parsed.filter((origin): origin is string => origin !== null))].sort())
          setDraft(null)
          setError(false)
        }}
      />
      {error && <span id={`${id}-error`} className={styles.validationError} role="alert">
        Use HTTP(S) origins without paths or credentials. Separate them with commas.
      </span>}
    </div>
  )
}
