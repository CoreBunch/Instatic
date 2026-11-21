import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import { ColorValueInput } from './ColorValueInput'

interface ColorControlProps extends ControlProps<string> {
  format?: 'hex' | 'rgba'
  richPicker?: boolean
  placeholder?: string
  /**
   * Optional hover-preview hooks. When provided (and the `hoverPreview`
   * editor preference is on), hovering a colour-token suggestion transiently
   * applies its `var(--…)` reference via `onPreview`; leaving / closing the
   * menu fires `onClearPreview`. Used by the style-rules panel (ClassPropertyRow
   * and BorderControl). Module-prop colour fields omit these.
   */
  onPreview?: (value: string) => void
  onClearPreview?: () => void
}

export function ColorControl({
  propKey,
  value,
  onChange,
  label,
  richPicker,
  placeholder,
  isOverride,
  disabled,
  layout,
  onPreview,
  onClearPreview,
}: ColorControlProps) {
  return (
    <ControlRow
      propKey={propKey}
      label={label}
      inputId={`ctrl-${propKey}-text`}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
    >
      <ColorValueInput
        id={`ctrl-${propKey}-text`}
        value={String(value ?? '')}
        disabled={disabled}
        ariaLabel={label ?? propKey}
        swatchLabel={`${label ?? propKey} colour swatch`}
        richPicker={richPicker}
      placeholder={placeholder}
        onChange={(next) => onChange(propKey, next)}
        onPreview={onPreview}
        onClearPreview={onClearPreview}
      />
    </ControlRow>
  )
}
