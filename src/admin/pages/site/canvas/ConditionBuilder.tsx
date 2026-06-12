/**
 * ConditionBuilder — guided authoring for a custom condition's query.
 *
 * Reduces the friction of the old raw-text-only field (unified-condition-axis
 * plan, P3). Per kind it offers accelerators that WRITE into the query string —
 * one-click presets, a width/size range builder, and (for @supports) a
 * property/value tester with a live `CSS.supports()` check. The raw query input
 * stays the editable source of truth + escape hatch, so anything the builders
 * can't express can still be typed by hand.
 */
import { useId, type ChangeEvent } from 'react'
import { Input } from '@ui/components/Input'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './CanvasContextSelector.module.css'

export type ConditionKind = 'media' | 'container' | 'supports'

interface Preset {
  label: string
  query: string
}

const MEDIA_PRESETS: ReadonlyArray<Preset> = [
  { label: 'Dark mode', query: '(prefers-color-scheme: dark)' },
  { label: 'Light mode', query: '(prefers-color-scheme: light)' },
  { label: 'Landscape', query: '(orientation: landscape)' },
  { label: 'Portrait', query: '(orientation: portrait)' },
  { label: 'Reduced motion', query: '(prefers-reduced-motion: reduce)' },
  { label: 'Print', query: 'print' },
  { label: 'Touch', query: '(pointer: coarse)' },
  { label: 'Mouse / hover', query: '(hover: hover)' },
]

const SUPPORTS_PRESETS: ReadonlyArray<Preset> = [
  { label: 'Grid', query: '(display: grid)' },
  { label: 'Flexbox', query: '(display: flex)' },
  { label: 'Gap', query: '(gap: 1rem)' },
  { label: 'Backdrop filter', query: '(backdrop-filter: blur(2px))' },
  { label: 'Aspect ratio', query: '(aspect-ratio: 1)' },
  { label: 'Subgrid', query: '(grid-template-columns: subgrid)' },
]

const UNIT_OPTIONS = [
  { value: 'px', label: 'px' },
  { value: 'em', label: 'em' },
  { value: 'rem', label: 'rem' },
]

/** Build an `(min-width: …) and (max-width: …)` query from the range fields. */
function buildRangeQuery(min: string, max: string, unit: string): string {
  const parts: string[] = []
  if (min.trim()) parts.push(`(min-width: ${min.trim()}${unit})`)
  if (max.trim()) parts.push(`(max-width: ${max.trim()}${unit})`)
  return parts.join(' and ')
}

/** Parse a `CSS.supports(prop, value)` from a `(prop: value)` query, if shaped that way. */
function parseFeature(query: string): { property: string; value: string } | null {
  const m = query.trim().match(/^\(\s*([\w-]+)\s*:\s*(.+?)\s*\)$/)
  if (!m) return null
  return { property: m[1], value: m[2] }
}

interface RangeState {
  min: string
  max: string
  unit: string
}

interface ConditionBuilderProps {
  kind: ConditionKind
  query: string
  onQueryChange: (query: string) => void
  /** Container name (only used / shown for kind === 'container'). */
  name: string
  onNameChange: (name: string) => void
  /** Range builder state, owned by the dialog so it survives kind switches. */
  range: RangeState
  onRangeChange: (range: RangeState) => void
}

export function ConditionBuilder({
  kind,
  query,
  onQueryChange,
  name,
  onNameChange,
  range,
  onRangeChange,
}: ConditionBuilderProps) {
  const queryId = useId()
  const nameId = useId()

  const presets = kind === 'media' ? MEDIA_PRESETS : kind === 'supports' ? SUPPORTS_PRESETS : []
  // Viewport width is the viewport-context model's job, not a condition — so the
  // range builder only applies to @container (which queries its own size).
  const showRange = kind === 'container'

  const applyRange = (next: RangeState) => {
    onRangeChange(next)
    const built = buildRangeQuery(next.min, next.max, next.unit)
    if (built) onQueryChange(built)
  }

  const feature = kind === 'supports' ? parseFeature(query) : null
  const supported =
    feature && typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      ? safeSupports(feature.property, feature.value)
      : null

  return (
    <>
      {kind === 'container' && (
        <div className={styles.field}>
          <label htmlFor={nameId} className={styles.label}>Container name (CSS, optional)</label>
          <Input
            id={nameId}
            fieldSize="sm"
            value={name}
            placeholder="sidebar"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
      )}

      {presets.length > 0 && (
        <div className={styles.field}>
          <span className={styles.label}>Presets</span>
          <div className={styles.chips}>
            {presets.map((preset) => (
              <Button
                key={preset.query}
                type="button"
                size="micro"
                variant={query.trim() === preset.query ? 'primary' : 'secondary'}
                aria-pressed={query.trim() === preset.query}
                onClick={() => onQueryChange(preset.query)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {showRange && (
        <div className={styles.field}>
          <span className={styles.label}>Container width</span>
          <div className={styles.rangeRow}>
            <Input
              fieldSize="sm"
              type="number"
              inputMode="numeric"
              value={range.min}
              placeholder="min"
              aria-label="Minimum width"
              onChange={(e: ChangeEvent<HTMLInputElement>) => applyRange({ ...range, min: e.target.value })}
            />
            <Input
              fieldSize="sm"
              type="number"
              inputMode="numeric"
              value={range.max}
              placeholder="max"
              aria-label="Maximum width"
              onChange={(e: ChangeEvent<HTMLInputElement>) => applyRange({ ...range, max: e.target.value })}
            />
            <Select
              value={range.unit}
              fieldSize="sm"
              aria-label="Width unit"
              options={UNIT_OPTIONS}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => applyRange({ ...range, unit: e.target.value })}
            />
          </div>
        </div>
      )}

      <div className={styles.field}>
        <label htmlFor={queryId} className={styles.label}>
          {kind === 'media' ? 'Media query' : kind === 'container' ? 'Container query' : 'Feature query'}
        </label>
        <Input
          id={queryId}
          fieldSize="sm"
          value={query}
          placeholder={kind === 'media' ? '(orientation: landscape)' : kind === 'container' ? 'min-width: 400px' : 'display: grid'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {kind === 'supports' && supported !== null && (
          <span className={`${styles.supportBadge} ${supported ? styles.supportYes : styles.supportNo}`} role="status">
            {supported
              ? <><CheckIcon size={11} aria-hidden="true" /> This browser supports it</>
              : <><CloseIcon size={11} aria-hidden="true" /> Not supported in this browser</>}
          </span>
        )}
      </div>
    </>
  )
}

/** `CSS.supports` can throw on malformed input — treat a throw as "unknown" (null upstream). */
function safeSupports(property: string, value: string): boolean | null {
  try {
    return CSS.supports(property, value)
  } catch {
    return null
  }
}
