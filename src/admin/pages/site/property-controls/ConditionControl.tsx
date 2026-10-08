import { PropertyConditionSchema, type PropertyCondition } from '@core/module-engine'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import type { ControlProps } from './shared'
import styles from './ConditionControl.module.css'

type Operator = 'eq' | 'notEq' | 'in' | 'notIn' | 'and' | 'or'
const OPTIONS: { value: Operator; label: string }[] = [
  { value: 'eq', label: 'Equals' }, { value: 'notEq', label: 'Does not equal' },
  { value: 'in', label: 'One of' }, { value: 'notIn', label: 'None of' },
  { value: 'and', label: 'All conditions' }, { value: 'or', label: 'Any condition' },
]

export function ConditionControl({ propKey, value, onChange, label, disabled }: ControlProps) {
  const condition = compiledCheck(PropertyConditionSchema, value) ? value : null
  const invalid = value !== null && value !== undefined && condition === null
  return <ControlRow propKey={propKey} label={label} layout="stacked" disabled={disabled}>
    {condition ? <div className={styles.control}>
      <ConditionEditor value={condition} disabled={disabled} onChange={(next) => onChange(propKey, next)} />
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(propKey, null)}>Remove condition</Button>
    </div> : <>
      {invalid && <span role="alert">This condition is invalid. Replace it with a declared rule.</span>}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(propKey, { field: 'field', eq: '' })}>{invalid ? 'Replace condition' : 'Add condition'}</Button>
    </>}
  </ControlRow>
}

function operator(value: PropertyCondition): Operator {
  if ('and' in value) return 'and'
  if ('or' in value) return 'or'
  if ('eq' in value) return 'eq'
  if ('notEq' in value) return 'notEq'
  if ('in' in value) return 'in'
  return 'notIn'
}

function ConditionEditor({ value, disabled, onChange }: {
  value: PropertyCondition; disabled?: boolean; onChange: (value: PropertyCondition) => void
}) {
  const op = operator(value)
  const children = 'and' in value ? value.and : 'or' in value ? value.or : null
  const field = 'field' in value ? value.field : 'field'
  function changeOperator(next: Operator) {
    if (next === 'and') onChange({ and: children ?? [value] })
    else if (next === 'or') onChange({ or: children ?? [value] })
    else if (next === 'in') onChange({ field, in: [''] })
    else if (next === 'notIn') onChange({ field, notIn: [''] })
    else if (next === 'eq') onChange({ field, eq: '' })
    else onChange({ field, notEq: '' })
  }
  return <div className={styles.control}>
    <Select aria-label="Condition operator" fieldSize="sm" value={op} disabled={disabled} onChange={(event) => {
      const match = OPTIONS.find((entry) => entry.value === event.target.value)
      if (match) changeOperator(match.value)
    }}>{OPTIONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select>
    {children ? <div className={styles.children}>
      {children.map((child, index) => <div className={styles.child} key={index}>
        <ConditionEditor value={child} disabled={disabled} onChange={(next) => {
          const updated = children.map((entry, i) => i === index ? next : entry)
          onChange(op === 'and' ? { and: updated } : { or: updated })
        }} />
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {
          const updated = children.filter((_, i) => i !== index)
          onChange(op === 'and' ? { and: updated } : { or: updated })
        }}>Remove</Button>
      </div>)}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => {
        const updated = [...children, { field: 'field', eq: '' }]
        onChange(op === 'and' ? { and: updated } : { or: updated })
      }}>Add rule</Button>
    </div> : <>
      <Input aria-label="Control name" fieldSize="sm" value={field} disabled={disabled} onChange={(event) => {
        if (event.target.value.trim()) onChange({ ...value, field: event.target.value })
      }} />
      {('in' in value || 'notIn' in value) ? (() => {
        const values = 'in' in value ? value.in : value.notIn
        function replace(next: unknown[]) { onChange(op === 'in' ? { field, in: next } : { field, notIn: next }) }
        return <div className={styles.control}>
          {values.map((item, index) => <div className={styles.value} key={index}>
            <Input aria-label={`Match value ${index + 1}`} fieldSize="sm" value={String(item ?? '')} disabled={disabled} onChange={(event) => replace(values.map((entry, i) => i === index ? event.target.value : entry))} />
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => replace(values.filter((_, i) => i !== index))}>Remove</Button>
          </div>)}
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => replace([...values, ''])}>Add value</Button>
        </div>
      })() : <Input aria-label="Match value" fieldSize="sm" value={String('eq' in value ? value.eq : 'notEq' in value ? value.notEq : '')} disabled={disabled} onChange={(event) => onChange(op === 'eq' ? { field, eq: event.target.value } : { field, notEq: event.target.value })} />}
    </>}
  </div>
}
