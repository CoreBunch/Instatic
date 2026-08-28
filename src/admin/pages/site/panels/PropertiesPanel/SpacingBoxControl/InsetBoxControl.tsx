/**
 * InsetBoxControl — the Position section's Inset editor
 * (docs/features/inspector-panel.md §6.2).
 *
 * The prototype does not give inset its own cross of four fields; it reuses
 * the Spacing section's vocabulary — the same box, the same faceted bands,
 * the same edge inputs — and swaps the middle. Where Spacing shows a core,
 * Inset shows a PINBOX: four bars, one per edge, that lock that edge's value.
 *
 * So this file shares `SpacingBoxControl.module.css` on purpose. The bands,
 * facets and side inputs are one look with two contents; giving inset its own
 * stylesheet is how the two would quietly drift apart.
 *
 * What a pin does: the value stays visible but stops accepting a caret, a
 * scrub or a step — that is what "pinned" means. The lock is panel state for
 * the session, not a stored property: CSS has nowhere to record "this edge is
 * locked", and inventing a key for it would put UI furniture in the document.
 */

import { useId, useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { PinBarGlyph } from '@ui/icons/inspectorGlyphs'
import { cn } from '@ui/cn'
import { hasStyleValue, stepCssLength } from '../styleValueUtils'
import styles from './SpacingBoxControl.module.css'

const SIDES = [
  { side: 'top', property: 'top', axis: 'y' },
  { side: 'right', property: 'right', axis: 'x' },
  { side: 'bottom', property: 'bottom', axis: 'y' },
  { side: 'left', property: 'left', axis: 'x' },
] as const

type InsetSide = (typeof SIDES)[number]['side']

interface InsetBoxControlProps {
  storedStyles: Record<string, unknown>
  currentStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

export function InsetBoxControl({
  storedStyles,
  currentStyles,
  onChange,
  onPreview,
  onClearPreview,
}: InsetBoxControlProps) {
  const tokens = useSpacingTokens()
  const [locked, setLocked] = useState<ReadonlySet<InsetSide>>(new Set())

  const toggleLock = (side: InsetSide) => {
    setLocked((current) => {
      const next = new Set(current)
      if (next.has(side)) next.delete(side)
      else next.add(side)
      return next
    })
  }

  return (
    <div className={styles.root}>
      <div className={cn(styles.box, styles['box--inset'])}>
        {SIDES.map(({ side, property }) => (
          <InsetSideInput
            key={side}
            side={side}
            property={property}
            stored={storedStyles[property]}
            current={currentStyles[property]}
            locked={locked.has(side)}
            tokens={tokens}
            onChange={onChange}
            onPreview={onPreview}
            onClearPreview={onClearPreview}
          />
        ))}

        <div className={styles.boxInner}>
          <div className={styles.pinbox}>
            {SIDES.map(({ side, axis }) => {
              const isLocked = locked.has(side)
              return (
                <Button
                  key={side}
                  variant="ghost"
                  size="micro"
                  iconOnly
                  className={cn(styles.pin, styles[`pin--${side}`])}
                  aria-pressed={isLocked}
                  aria-label={`${isLocked ? 'Unpin' : 'Pin'} ${side} edge`}
                  tooltip={isLocked ? `Unpin ${side}` : `Pin ${side}`}
                  onClick={() => toggleLock(side)}
                >
                  <PinBarGlyph axis={axis} />
                </Button>
              )
            })}
            {/* Pure visualisation — see the file header. */}
            <span className={styles.pinCore} aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}

interface InsetSideInputProps {
  side: InsetSide
  property: 'top' | 'right' | 'bottom' | 'left'
  stored: unknown
  current: unknown
  locked: boolean
  tokens: ReturnType<typeof useSpacingTokens>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

function InsetSideInput({
  side,
  property,
  stored,
  current,
  locked,
  tokens,
  onChange,
  onPreview,
  onClearPreview,
}: InsetSideInputProps) {
  const inputId = useId()
  const isSet = hasStyleValue(stored)
  const value = isSet ? String(stored) : ''
  // `auto` is what an unset offset actually resolves to, so it is the honest
  // placeholder — not `0`, which would claim the element is pinned to the edge.
  const placeholder = hasStyleValue(current) ? String(current) : 'auto'

  return (
    <label
      htmlFor={inputId}
      className={cn(styles.segment, styles[`segment--${side}`])}
      data-state={isSet ? 'set' : 'unset'}
      data-locked={locked ? 'true' : undefined}
    >
      <TokenAwareInput
        id={inputId}
        value={value}
        placeholder={placeholder}
        tokens={tokens}
        fieldSize="xs"
        overlay
        tooltipOnOverflow
        readOnly={locked}
        aria-label={`Inset ${side}`}
        menuAriaLabel={`Inset ${side} spacing tokens`}
        inputClassName={styles.sideInput}
        onCommit={(resolved) => {
          if (locked) return
          onChange(property, resolved)
        }}
        onStep={(delta) => {
          if (locked) return
          // Offsets go negative — pulling an element past its edge is normal.
          const next = stepCssLength(value || (placeholder === 'auto' ? '0px' : placeholder), delta, {
            min: Number.NEGATIVE_INFINITY,
          })
          if (next) onChange(property, next)
        }}
        onPreview={
          onPreview && !locked
            ? (resolved) => onPreview({ [property]: resolved ?? null } as Partial<CSSPropertyBag>)
            : undefined
        }
        onClearPreview={onClearPreview}
      />
    </label>
  )
}
