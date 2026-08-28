/**
 * EffectParams — the body of an effect's popout (inspector-panel.md §6.5).
 *
 * Each effect type brings its own set of fields, and that IS the difference
 * between them: a shadow has offsets, blur, spread and colour; a blur has one
 * number. Rows use the popout's `narrow` label column (52px).
 */

import type { CSSProperties } from 'react'
import { ControlRow } from '@ui/components/ControlRow'
import { Input } from '@ui/components/Input'
import { ColorInput } from '@ui/components/ColorInput'
import type { EffectEntry, ShadowEffect } from './effectsModel'
import { stepCssLength } from './styleValueUtils'
import styles from './EffectsSection.module.css'

interface EffectParamsProps {
  effect: EffectEntry
  onChangeShadow: (next: ShadowEffect) => void
  onChangeBlur: (next: string) => void
}

export function EffectParams({ effect, onChangeShadow, onChangeBlur }: EffectParamsProps) {
  const shadow = effect.shadow

  if (!shadow) {
    return (
      <div className={styles.params}>
        <ControlRow propKey="blur" label="Blur" narrow>
          <Input
            aria-label="Blur"
            value={effect.blur ?? ''}
            onChange={(event) => onChangeBlur(event.target.value)}
            onStep={(delta) => {
              const next = stepCssLength(effect.blur ?? '0px', delta)
              if (next) onChangeBlur(next)
            }}
          />
        </ControlRow>
      </div>
    )
  }

  const patch = (part: Partial<ShadowEffect>) => onChangeShadow({ ...shadow, ...part })

  return (
    <div className={styles.params}>
      <ControlRow propKey="position" label="Position" narrow>
        <div className={styles.pair}>
          <Input
            aria-label="Offset x"
            value={shadow.x}
            onChange={(event) => patch({ x: event.target.value })}
            onStep={(delta) => {
              const next = stepCssLength(shadow.x, delta, { min: Number.NEGATIVE_INFINITY })
              if (next) patch({ x: next })
            }}
          />
          <Input
            aria-label="Offset y"
            value={shadow.y}
            onChange={(event) => patch({ y: event.target.value })}
            onStep={(delta) => {
              const next = stepCssLength(shadow.y, delta, { min: Number.NEGATIVE_INFINITY })
              if (next) patch({ y: next })
            }}
          />
        </div>
      </ControlRow>
      <ControlRow propKey="blur" label="Blur" narrow>
        <Input
          aria-label="Blur"
          value={shadow.blur}
          onChange={(event) => patch({ blur: event.target.value })}
          onStep={(delta) => {
            const next = stepCssLength(shadow.blur, delta)
            if (next) patch({ blur: next })
          }}
        />
      </ControlRow>
      <ControlRow propKey="spread" label="Spread" narrow>
        <Input
          aria-label="Spread"
          value={shadow.spread}
          onChange={(event) => patch({ spread: event.target.value })}
          onStep={(delta) => {
            const next = stepCssLength(shadow.spread, delta, { min: Number.NEGATIVE_INFINITY })
            if (next) patch({ spread: next })
          }}
        />
      </ControlRow>
      <ControlRow propKey="color" label="Color" narrow>
        <div className={styles.colorRow} style={{ '--effect-color': shadow.color } as CSSProperties}>
          <ColorInput
            aria-label="Shadow colour"
            value={shadow.color}
            onValueChange={(next) => patch({ color: next })}
          />
          <Input
            aria-label="Shadow colour value"
            value={shadow.color}
            onChange={(event) => patch({ color: event.target.value })}
          />
        </div>
      </ControlRow>
    </div>
  )
}
