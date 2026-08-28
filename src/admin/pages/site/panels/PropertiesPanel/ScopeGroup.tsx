/**
 * ScopeGroup — one value for the whole thing, or one per part.
 *
 * The shared shape behind Padding (4 sides), Radius (4 corners) and Rotate
 * (3 axes), specified in docs/features/inspector-panel.md §6.1:
 *
 *   Padding   [ 0 ]  ← dimmed in "parts" mode      [▢][⛶]
 *             [0] [0] [0] [0]
 *              T   R   B   L
 *
 * Three rules it exists to keep:
 *
 *  1. **The first line never changes shape.** One field plus the scope
 *     toggle, in both modes. Swapping the field out for a grid of four made
 *     the row jump and moved the toggle under the cursor.
 *  2. **In "parts" mode the linked field stays and dims** — really disabled
 *     (the caller passes `disabled`), so it cannot be clicked, tabbed into or
 *     scrubbed, not merely greyed.
 *  3. **The parts block takes the whole control column**, including the space
 *     under the toggle, and the letters sit BELOW the fields — inside them
 *     they would fight the value for the same 30px.
 */

import type { ReactNode } from 'react'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { AllSidesGlyph } from '@ui/icons/inspectorGlyphs'
import styles from './ScopeGroup.module.css'

export type ScopeMode = 'all' | 'parts'

export interface ScopePart {
  /** React key + the letter shown under the field (T / R / B / L, X / Y / Z). */
  tag: string
  field: ReactNode
}

interface ScopeGroupProps {
  /** Rendered by the caller so each section keeps its own label anatomy. */
  label: ReactNode
  mode: ScopeMode
  onModeChange: (next: ScopeMode) => void
  /** Icon for the "parts" segment — per-side, per-corner or per-axis. */
  partsIcon: ReactNode
  partsAriaLabel: string
  allAriaLabel?: string
  scopeAriaLabel: string
  /** The single field. Always mounted; the caller disables it in parts mode. */
  linked: ReactNode
  parts: ReadonlyArray<ScopePart>
  isSet: boolean
  testId?: string
}

export function ScopeGroup({
  label,
  mode,
  onModeChange,
  partsIcon,
  partsAriaLabel,
  allAriaLabel = 'All sides',
  scopeAriaLabel,
  linked,
  parts,
  isSet,
  testId,
}: ScopeGroupProps) {
  return (
    <div
      className={styles.row}
      data-state={isSet ? 'set' : 'unset'}
      data-mode={mode}
      data-testid={testId}
    >
      {label}
      <div className={styles.control}>
        <div className={styles.head}>
          <div className={styles.linked}>{linked}</div>
          <SegmentedControl<ScopeMode>
            fullWidth
            aria-label={scopeAriaLabel}
            value={mode}
            onChange={onModeChange}
            options={[
              { value: 'all', icon: <AllSidesGlyph />, ariaLabel: allAriaLabel },
              { value: 'parts', icon: partsIcon, ariaLabel: partsAriaLabel },
            ]}
          />
        </div>
        {mode === 'parts' && (
          <div
            className={styles.parts}
            style={{ '--scope-parts': parts.length } as React.CSSProperties}
          >
            {parts.map((part) => (
              <div key={part.tag} className={styles.part}>
                {part.field}
                <span className={styles.partTag} aria-hidden="true">
                  {part.tag}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
