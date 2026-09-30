import { ANIMATION_PRESETS, parseAnimationPreset } from '@core/animationPresets'
import { Input } from '@ui/components/Input'
import { ControlRow } from '@ui/components/ControlRow'
import { SelectControl } from './SelectControl'
import { TextControl } from './TextControl'
import type { ControlProps } from './shared'

export function AnimationControl({ propKey, value, onChange, label }: ControlProps<string>) {
  const preset = parseAnimationPreset(value)
  const selected = preset?.name ?? (value && value !== 'none' ? 'custom' : value)
  const update = (patch: Partial<NonNullable<typeof preset>>) => {
    const next = { name: 'instatic-fade-in', trigger: 'load', duration: 600, easing: 'ease-out', delay: 0, ...preset, ...patch }
    const name = next.trigger === 'scroll' ? `${next.name}-scroll` : next.name
    onChange(propKey, `${name} ${next.duration}ms ${next.easing} ${next.delay}ms 1 both`)
  }
  return <>
    <SelectControl
      propKey={propKey}
      label={label}
      value={selected}
      options={[
        { value: '', label: 'Inherited' },
        { value: 'none', label: 'None' },
        ...ANIMATION_PRESETS,
        { value: 'custom', label: 'Custom CSS' },
      ]}
      onChange={(_, next) => {
        const name = String(next)
        if (name === 'custom') onChange(propKey, 'initial')
        else if (name === '' || name === 'none') onChange(propKey, name)
        else update({ name })
      }}
    />
    {preset && <>
      <SelectControl propKey={`${propKey}-trigger`} label="Trigger" value={preset.trigger}
        options={[{ value: 'load', label: 'On load' }, { value: 'scroll', label: 'On scroll into view' }]}
        onChange={(_, trigger) => update({ trigger: String(trigger) })} />
      <ControlRow propKey={`${propKey}-duration`} label="Duration (ms)">
        <Input id={`ctrl-${propKey}-duration`} type="number" min={1} max={60000} step={50} fieldSize="sm"
          value={preset.duration} onChange={event => {
            const duration = event.target.valueAsNumber
            if (Number.isFinite(duration) && duration > 0 && duration <= 60000) update({ duration })
          }} />
      </ControlRow>
      <ControlRow propKey={`${propKey}-delay`} label="Delay (ms)">
        <Input id={`ctrl-${propKey}-delay`} type="number" min={0} max={60000} step={50} fieldSize="sm"
          value={preset.delay} onChange={event => {
            const delay = event.target.valueAsNumber
            if (Number.isFinite(delay) && delay >= 0 && delay <= 60000) update({ delay })
          }} />
      </ControlRow>
      <SelectControl propKey={`${propKey}-easing`} label="Easing" value={preset.easing}
        options={['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear'].map(option => ({ value: option, label: option }))}
        onChange={(_, easing) => update({ easing: String(easing) })} />
    </>}
    {selected === 'custom' && <TextControl propKey={`${propKey}-css`} label="Animation CSS"
      value={value} onChange={(_, css) => onChange(propKey, String(css))} />}
  </>
}
