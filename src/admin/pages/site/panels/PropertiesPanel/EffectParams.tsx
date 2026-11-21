/**
 * EffectParams — the body of an effect's popout.
 *
 * Each effect type brings its own set of fields, and that IS the difference
 * between them: a shadow has offsets, blur, spread and colour; a blur has one
 * number. Rows use the popout's `narrow` label column (52px).
 */

import { useState } from 'react'
import { ControlRow } from '@ui/components/ControlRow'
import { NumericStyleInput } from '@site/property-controls/NumericStyleInput'
import { ColorValueInput } from '@site/property-controls/ColorValueInput'
import type { EffectEntry, ShadowEffect } from './effectsModel'
import styles from './EffectsSection.module.css'

interface EffectParamsProps {
  onClearPreview: () => void
  effect: EffectEntry
  onChangeShadow: (next: ShadowEffect, preview?: boolean) => void
  onChangeBlur: (next: string, preview?: boolean) => void
}

function LengthInput({ label, value, onCommit, onClearPreview }: { label: string; value: string; onClearPreview: () => void; onCommit: (value: string, preview?: boolean) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return <NumericStyleInput onScrubPreview={(v) => onCommit(v, true)} onClearPreview={onClearPreview} defaultUnit="px" min={label === 'Blur' ? 0 : undefined} onAdjust={(value) => { setDraft(null); onCommit(value) }} fieldSize="xs" id={'effect-' + label.toLowerCase().replace(' ', '-')} aria-label={label} value={draft ?? value}
    onChange={(event) => setDraft(event.target.value)}
    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
    onBlur={() => {
      if (draft === null) return
      const text = draft.trim()
      const length = /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text) ? text + 'px' : text
      if (length && CSS.supports('box-shadow', label === 'Blur' ? '0 0 ' + length : length + ' 0')) onCommit(length)
      setDraft(null)
    }} />
}

export function EffectParams({ effect, onChangeShadow, onChangeBlur, onClearPreview }: EffectParamsProps) {
  const shadow = effect.shadow

  if (!shadow) {
    return (
      <div className={styles.params}>
        <ControlRow propKey="blur" inputId="effect-blur" label="Blur">
          <LengthInput onClearPreview={onClearPreview} label="Blur" value={effect.blur ?? ''} onCommit={onChangeBlur} />
        </ControlRow>
      </div>
    )
  }

  const patch = (part: Partial<ShadowEffect>, preview?: boolean) => onChangeShadow({ ...shadow, ...part }, preview)

  return (
    <div className={styles.params}>
      <ControlRow propKey="position" inputId="effect-offset-x" label="Position">
        <div className={styles.pair}>
          <LengthInput onClearPreview={onClearPreview} label="Offset x" value={shadow.x} onCommit={(value, preview) => patch({ x: value }, preview)} />
          <LengthInput onClearPreview={onClearPreview} label="Offset y" value={shadow.y} onCommit={(value, preview) => patch({ y: value }, preview)} />
        </div>
      </ControlRow>
      <ControlRow propKey="blur" inputId="effect-blur" label="Blur">
        <LengthInput onClearPreview={onClearPreview} label="Blur" value={shadow.blur} onCommit={(value, preview) => patch({ blur: value }, preview)} />
      </ControlRow>
      <ControlRow propKey="spread" inputId="effect-spread" label="Spread">
        <LengthInput onClearPreview={onClearPreview} label="Spread" value={shadow.spread} onCommit={(value, preview) => patch({ spread: value }, preview)} />
      </ControlRow>
      <ControlRow propKey="color" label="Color">
        <ColorValueInput richPicker id="ctrl-color" value={shadow.color} ariaLabel="Shadow color" swatchLabel="Pick shadow color"
          onChange={(color) => patch({ color })} />
      </ControlRow>
    </div>
  )
}
