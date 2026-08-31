/**
 * EffectsSection — effects as a list of named things, not as raw declarations
 * (docs/features/inspector-panel.md §6.5).
 *
 * The prototype's Effects section does not show `box-shadow` and `filter`; it
 * shows "Drop shadow", "Inner shadow", "Layer blur", "Background blur", each
 * an ordinary panel row: name in the label column, a leading value in the
 * control column, and the parameters behind a floating popout. What that maps
 * onto in CSS lives in `effectsModel`.
 *
 * Four effects, because those are the ones with a clean CSS counterpart. The
 * prototype's Texture and Glass are not single properties and stay out.
 *
 * Deliberately NO eye (author's decision, 2026-08-28): CSS has no "disabled
 * shadow", so a hidden effect would need a new key in the style model to live
 * in. The row carries the dash handle only — see §6.5's implementation note.
 *
 * `transition` and `animation` keep plain rows (they are declarations the
 * author writes, not objects with parameters) — but like everything else in
 * this section they exist only once added: the header's "+" lists them under
 * the effect catalogue, and an added row carries the remove handle.
 */

import { useRef, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { RemoveDashGlyph } from '@ui/icons/inspectorGlyphs'
import { ClassPropertyRow } from './ClassPropertyRow'
import {
  EFFECT_LABELS,
  formatShadowList,
  parseShadowList,
  readEffects,
  writeBlur,
  type EffectEntry,
  type ShadowEffect,
} from './effectsModel'
import { EffectParams } from './EffectParams'
import { BlurGlyph, ShadowGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './EffectsSection.module.css'

interface EffectsSectionProps {
  storedStyles: Record<string, unknown>
  activeTab: string
  /** Search-filtered property list — the plain rows respect it. */
  visibleProperties: ReadonlyArray<keyof CSSPropertyBag>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function EffectsSection({
  storedStyles,
  activeTab,
  visibleProperties,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: EffectsSectionProps) {
  const effects = readEffects(storedStyles)
  const visible = new Set(visibleProperties)

  // Writing one shadow means rewriting the whole list — the other entries are
  // read back from the store and re-emitted untouched.
  const writeShadow = (index: number, next: ShadowEffect | null) => {
    const list = parseShadowList(storedStyles.boxShadow)
    if (next === null) list.splice(index, 1)
    else list[index] = next
    onChange('boxShadow', formatShadowList(list))
  }

  return (
    <>
      {effects.map((effect) => (
        <EffectRow
          key={`${activeTab}-${effect.kind}-${effect.shadowIndex ?? 0}`}
          effect={effect}
          onChangeShadow={(next) => writeShadow(effect.shadowIndex ?? 0, next)}
          onChangeBlur={(next) => {
            const property = effect.kind === 'layerBlur' ? 'filter' : 'backdropFilter'
            onChange(property, writeBlur(storedStyles[property], next))
          }}
        />
      ))}

      {/* Declarations, not objects — ordinary rows, but only once SET: the
          section starts empty, and the header's "+" lists Transition and
          Animation alongside the effect catalogue (EffectAddMenu). */}
      {(['transition', 'animation'] as const)
        .filter((prop) => visible.has(prop) && hasValue(storedStyles[prop]))
        .map((prop) => (
          <ClassPropertyRow
            key={`${activeTab}-${prop}`}
            property={prop}
            value={storedStyles[prop] as string}
            isSet
            removable
            onChange={onChange}
            onRemove={onRemove}
            onPreview={
              onPreview
                ? (property, value) =>
                    onPreview({ [property]: value ?? null } as Partial<CSSPropertyBag>)
                : undefined
            }
            onClearPreview={onClearPreview}
          />
        ))}
    </>
  )
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value != null
}

interface EffectRowProps {
  effect: EffectEntry
  onChangeShadow: (next: ShadowEffect | null) => void
  onChangeBlur: (next: string | null) => void
}

function EffectRow({ effect, onChangeShadow, onChangeBlur }: EffectRowProps) {
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
          {isShadow ? <ShadowGlyph /> : <BlurGlyph />}
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
        <RemoveDashGlyph />
      </Button>
      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        title={label}
        closeLabel={`Close ${label} settings`}
        estimatedHeight={220}
      >
        <EffectParams
          effect={effect}
          onChangeShadow={onChangeShadow}
          onChangeBlur={onChangeBlur}
        />
      </FloatingPanel>
    </div>
  )
}
