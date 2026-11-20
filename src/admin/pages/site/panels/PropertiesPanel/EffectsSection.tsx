/** Editable shadow and blur layers for the current style target. */
import { Suspense, useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import {
  EFFECT_LABELS,
  changeShadow,
  readEffects,
  writeBlur,
  type EffectEntry,
  type ShadowEffect,
} from './effectsModel'
import { EffectParams } from './EffectParams'
import { SparklesSolidIcon } from 'pixel-art-icons/icons/sparkles-solid'
import { BoxSolidIcon } from 'pixel-art-icons/icons/box-solid'
import styles from './EffectsSection.module.css'

interface EffectsSectionProps {
  storedStyles: Record<string, unknown>
  activeTab: string
  /** Search-filtered property list — the plain rows respect it. */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  onPreview: EffectsSectionProps['onChange']
  onClearPreview: () => void
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
}

export function EffectsSection({
  storedStyles,
  activeTab,
  visibleProperties,
  onChange,
  onPreview,
  onClearPreview,
}: EffectsSectionProps) {
  const effects = readEffects(storedStyles).filter((entry) => visibleProperties.includes(
    entry.shadow ? 'boxShadow' : entry.kind === 'layerBlur' ? 'filter' : 'backdropFilter',
  ))

  // Writing one shadow means rewriting the whole list — the other entries are
  // read back from the store and re-emitted untouched.
  const writeShadow = (index: number, next: ShadowEffect | null, apply = onChange) => {
    apply('boxShadow', changeShadow(storedStyles.boxShadow, index, next) ?? (activeTab === 'base' ? undefined : 'none'))
  }

  return (
    <>
      {effects.map((effect) => (
        <EffectRow
          key={`${activeTab}-${effect.kind}-${effect.shadowIndex ?? 0}`}
          effect={effect}
          onClearPreview={onClearPreview}
          onChangeShadow={(next, preview) => writeShadow(effect.shadowIndex ?? 0, next, preview ? onPreview : onChange)}
          onChangeBlur={(next, preview) => {
            const apply = preview ? onPreview : onChange
            const property = effect.kind === 'layerBlur' ? 'filter' : 'backdropFilter'
            apply(property, writeBlur(storedStyles[property], next) ?? (activeTab === 'base' ? undefined : 'none'))
          }}
        />
      ))}
    </>
  )
}

interface EffectRowProps {
  onClearPreview: () => void
  effect: EffectEntry
  onChangeShadow: (next: ShadowEffect | null, preview?: boolean) => void
  onChangeBlur: (next: string | null, preview?: boolean) => void
}

function EffectRow({ effect, onChangeShadow, onChangeBlur, onClearPreview }: EffectRowProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const label = EFFECT_LABELS[effect.kind]
  const isShadow = effect.shadow !== undefined

  return (
    <div className={styles.row} data-state="set" data-testid={`effect-row-${effect.kind}`}>
      <span className={styles.label}>
        <span className={styles.dot} aria-hidden="true" />
        {label}
      </span>
      {/* The trigger IS the field: it carries the type glyph, the leading
          value, and opens the parameters. */}
      <Button
        ref={triggerRef}
        variant="ghost"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label} — edit`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.glyph} aria-hidden="true">
          {isShadow ? <BoxSolidIcon size={13} /> : <SparklesSolidIcon size={13} />}
        </span>
        <span className={styles.value}>{effect.summary}</span>
      </Button>
      <Button
        variant="ghost"
        size="micro"
        iconOnly
        className={styles.remove}
        aria-label={`Remove ${label}`}
        tooltip={`Remove ${label}`}
        onClick={() => {
          setOpen(false)
          if (isShadow) onChangeShadow(null)
          else onChangeBlur(null)
        }}
      >
        <MinusIcon size={12} />
      </Button>
      {open && <Suspense fallback={null}><FloatingPanel
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        title={label}
        closeLabel={`Close ${label} settings`}
        width={286}
      >
        <EffectParams
          onClearPreview={onClearPreview}
          effect={effect}
          onChangeShadow={onChangeShadow}
          onChangeBlur={onChangeBlur}
        />
      </FloatingPanel></Suspense>}
    </div>
  )
}
