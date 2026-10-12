import type { ControlProps } from './shared'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import styles from './controls.module.css'
import controlRowStyles from '@ui/components/ControlRow/ControlRow.module.css'

interface NumberControlProps extends ControlProps<number> {
  min?: number
  max?: number
  step?: number
  unit?: string
  /** Suggested values offered as buttons under the field. */
  presets?: number[]
}

export function NumberControl({
  propKey,
  value,
  onChange,
  label,
  min,
  max,
  step = 1,
  unit,
  presets,
  isOverride,
  disabled,
  layout,
}: NumberControlProps) {
  const input = (
    <Input
      id={`ctrl-${propKey}`}
      type="number"
      value={value ?? 0}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      fieldSize="sm"
      onChange={(e) => {
        const v = e.target.valueAsNumber
        if (!isNaN(v)) onChange(propKey, v)
      }}
    />
  )

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={unit ? <span className={controlRowStyles.labelUnit}>{unit}</span> : undefined}
    >
      {presets && presets.length > 0 ? (
        <div className={styles.numberWithPresets}>
          {input}
          <SegmentedControl
            aria-label={`${label ?? propKey} presets`}
            value={presets.includes(value) ? String(value) : undefined}
            options={presets.map((preset) => ({ value: String(preset), label: String(preset) }))}
            onChange={(next) => onChange(propKey, Number(next))}
            disabled={disabled}
            fullWidth
          />
        </div>
      ) : input}
    </ControlRow>
  )
}
