/**
 * GapInput — two token-aware fields (x = column gap, y = row gap) writing the
 * unified `gap` shorthand (inspector redesign's "Gap [x] [y]" row).
 *
 * One CSS property, one undo entry per commit: equal axes collapse to the
 * single-value shorthand (`gap: 12px`), unequal axes emit `gap: <row> <col>`.
 * Backed by `TokenAwareInput` so users get framework spacing variable
 * autocomplete — same vocabulary as the SpacingBoxControl side inputs.
 */

import { TokenAwareInput } from '@site/property-controls/TokenAwareInput'
import { useSpacingTokens } from '@site/property-controls/tokenUtils'
import { stepCssLength } from '../styleValueUtils'
import { ControlRow } from '@ui/components/ControlRow'
import styles from '../LayoutSection.module.css'

interface GapInputProps {
  value: string | undefined
  isSet: boolean
  onChange: (value: string | undefined) => void
  /** Hover / as-you-type preview of the resolved gap value (token-aware). */
  onPreview?: (value: string | undefined) => void
  onClearPreview?: () => void
}

/** Split a `gap` shorthand into [row, column] at the top level (paren-aware). */
function parseGap(value: string | undefined): [string | undefined, string | undefined] {
  if (!value) return [undefined, undefined]
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  if (parts.length === 0) return [undefined, undefined]
  if (parts.length === 1) return [parts[0], parts[0]]
  return [parts[0], parts[1]]
}

function formatGap(row: string | undefined, column: string | undefined): string | undefined {
  if (!row && !column) return undefined
  const r = row || column
  const c = column || row
  return r === c ? r : `${r} ${c}`
}

export function GapInput({ value, isSet, onChange, onPreview, onClearPreview }: GapInputProps) {
  const tokens = useSpacingTokens()
  const [row, column] = parseGap(value)

  return (
    <ControlRow label="Gap" isSet={isSet}>
      <div className={styles.gapDuo}>
        <div className={styles.gapCell}>
          <TokenAwareInput
            aria-label="Column gap (x)"
            value={column}
            placeholder="0px"
            tokens={tokens}
            onCommit={(resolved) => onChange(formatGap(row, resolved))}
            onStep={(delta) => {
              const next = stepCssLength(column || '0px', delta)
              if (next) onChange(formatGap(row, next))
            }}
            onPreview={onPreview ? (resolved) => onPreview(formatGap(row, resolved)) : undefined}
            onClearPreview={onClearPreview}
          />
          <span className={styles.gapAxis} aria-hidden="true">x</span>
        </div>
        <div className={styles.gapCell}>
          <TokenAwareInput
            aria-label="Row gap (y)"
            value={row}
            placeholder="0px"
            tokens={tokens}
            onCommit={(resolved) => onChange(formatGap(resolved, column))}
            onStep={(delta) => {
              const next = stepCssLength(row || '0px', delta)
              if (next) onChange(formatGap(next, column))
            }}
            onPreview={onPreview ? (resolved) => onPreview(formatGap(resolved, column)) : undefined}
            onClearPreview={onClearPreview}
          />
          <span className={styles.gapAxis} aria-hidden="true">y</span>
        </div>
      </div>
    </ControlRow>
  )
}
