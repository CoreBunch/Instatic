/**
 * PaddingRow — the Layout section's quick padding row (inspector redesign):
 *
 *   Padding  [ value ]  [ ◻ all | ⊞ per-side ]
 *
 * "All" mode writes the four per-side paddings in ONE store commit; when the
 * stored sides disagree the field shows a "Mixed" placeholder. "Per-side"
 * mode reveals the T / R / B / L block under it while the linked field stays
 * put and dims — the shared ScopeGroup shape (inspector-panel.md §6.1), which
 * Radius uses too. The full margin+padding trapezoid stays in the Spacing
 * section; this row is the fast path the prototype puts directly under Gap.
 */

import { useState } from 'react'
import type { CSSPropertyBag } from '@core/page-tree'
import { PerSideGlyph } from '@ui/icons/inspectorGlyphs'
import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { ScopeGroup, type ScopeMode } from '../ScopeGroup'
import { stepCssLength } from '../styleValueUtils'
import styles from '../LayoutSection.module.css'

const SIDES = [
  { prop: 'paddingTop', tag: 'T', label: 'Padding top' },
  { prop: 'paddingRight', tag: 'R', label: 'Padding right' },
  { prop: 'paddingBottom', tag: 'B', label: 'Padding bottom' },
  { prop: 'paddingLeft', tag: 'L', label: 'Padding left' },
] as const

interface PaddingRowProps {
  currentStyles: Record<string, unknown>
  storedStyles: Record<string, unknown>
  onChange: (property: keyof CSSPropertyBag, value: string | number | undefined) => void
  /** Applies all four sides in one store commit (one undo entry). */
  onChangeMany: (patch: Partial<CSSPropertyBag>) => void
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  onClearPreview?: () => void
}

function readSide(bag: Record<string, unknown>, prop: string): string | undefined {
  const value = bag[prop]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function PaddingRow({
  currentStyles,
  storedStyles,
  onChange,
  onChangeMany,
  onPreview,
  onClearPreview,
}: PaddingRowProps) {
  const tokens = useSpacingTokens()
  const stored = SIDES.map(({ prop }) => readSide(storedStyles, prop))
  const anySet = stored.some((side) => side !== undefined)
  const uniform =
    anySet && stored.every((side) => side !== undefined && side === stored[0])
      ? stored[0]
      : undefined

  const [mode, setMode] = useState<ScopeMode>('all')

  const commitAll = (resolved: string | undefined) => {
    onChangeMany({
      paddingTop: resolved,
      paddingRight: resolved,
      paddingBottom: resolved,
      paddingLeft: resolved,
    })
  }

  const previewAll = onPreview
    ? (resolved: string | undefined) =>
        onPreview({
          paddingTop: resolved ?? null,
          paddingRight: resolved ?? null,
          paddingBottom: resolved ?? null,
          paddingLeft: resolved ?? null,
        } as Partial<CSSPropertyBag>)
    : undefined

  return (
    <ScopeGroup
      testId="css-padding-row"
      isSet={anySet}
      label={
        <span className={styles.labeledLabel}>
          {anySet && <span className={styles.labeledDot} aria-hidden="true" />}
          Padding
        </span>
      }
      mode={mode}
      onModeChange={setMode}
      scopeAriaLabel="Padding scope"
      partsAriaLabel="Each side separately"
      partsIcon={<PerSideGlyph />}
      linked={
        <TokenAwareInput
          aria-label="Padding (all sides)"
          value={uniform}
          placeholder={anySet && !uniform ? 'Mixed' : '0px'}
          tokens={tokens}
          disabled={mode === 'parts'}
          onCommit={commitAll}
          onStep={(delta) => {
            const next = stepCssLength(uniform || '0px', delta)
            if (next) commitAll(next)
          }}
          onPreview={previewAll}
          onClearPreview={onClearPreview}
        />
      }
      parts={SIDES.map(({ prop, tag, label }) => ({
        tag,
        field: (
          <TokenAwareInput
            aria-label={label}
            value={readSide(storedStyles, prop)}
            placeholder={readSide(currentStyles, prop) ?? '0'}
            tokens={tokens}
            onCommit={(resolved) => onChange(prop, resolved)}
            onStep={(delta) => {
              const next = stepCssLength(readSide(storedStyles, prop) ?? '0px', delta)
              if (next) onChange(prop, next)
            }}
            onPreview={
              onPreview
                ? (resolved) => onPreview({ [prop]: resolved ?? null } as Partial<CSSPropertyBag>)
                : undefined
            }
            onClearPreview={onClearPreview}
          />
        ),
      }))}
    />
  )
}
