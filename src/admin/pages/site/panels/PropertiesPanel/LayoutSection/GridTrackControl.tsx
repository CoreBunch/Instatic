/**
 * GridTrackControl — quick column / row count picker for `grid-template-*`.
 *
 * Three visual states — same shape as DisplaySwitcher so the language is
 * consistent across the section:
 *
 *   1. unset / preset-count — segmented `[2 | 3 | 4 | 5 | 6 | ⋯]` with the
 *      matching count pressed (or none). Hovering a pressed segment shows the
 *      X overlay; clicking it clears the property entirely.
 *   2. custom value — full-width chip showing the raw template (e.g.
 *      `200px 1fr 200px`) with a square close button. Clicking the chip enters
 *      edit mode.
 *   3. edit mode — text input replacing the row. Enter / blur applies, Escape
 *      cancels. Toggleable via the trailing chevron in state #1 or by clicking
 *      the chip body in state #2.
 */

import { useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { LabeledControl } from './LabeledControl'
import styles from '../LayoutSection.module.css'

/**
 * Common track counts surfaced as primary segments. Picking N writes
 * `repeat(N, 1fr)` to the property — covering 95% of real-world layouts
 * without touching the underlying CSS shorthand. 1 is intentionally
 * omitted because a single full-width track is just the default block
 * flow and doesn't need a dedicated grid control. Custom track templates
 * (named tracks, mixed sizing, subgrid, single tracks, …) fall back to
 * the inline text input revealed via the trailing chevron.
 */
const GRID_PRESETS = [2, 3, 4, 5, 6] as const

interface GridTrackControlProps {
  label: string
  ariaLabel: string
  value: string | undefined
  isSet: boolean
  onChange: (value: string) => void
  onClear: () => void
}

export function GridTrackControl({
  label,
  ariaLabel,
  value,
  isSet,
  onChange,
  onClear,
}: GridTrackControlProps) {
  const presetN = parseGridRepeat(value)
  const isPreset =
    presetN != null && (GRID_PRESETS as ReadonlyArray<number>).includes(presetN)
  const isCustomValue = value != null && value !== '' && !isPreset

  // Local state for the inline text-input edit mode.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  // Whenever the canonical value changes externally (e.g. a different node
  // selected, undo, or a sibling control), drop any stale draft so the next
  // entry into edit mode starts from the current value.
  if (!editing && draft !== (value ?? '')) {
    setDraft(value ?? '')
  }

  function enterEditMode() {
    setDraft(value ?? '')
    setEditing(true)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function commitDraft() {
    const trimmed = draft.trim()
    setEditing(false)
    if (trimmed === '') {
      if (value != null && value !== '') onClear()
      return
    }
    if (trimmed === value) return
    onChange(trimmed)
  }

  function cancelDraft() {
    setEditing(false)
    setDraft(value ?? '')
  }

  // ── Edit mode — inline text input ─────────────────────────────────────────
  if (editing) {
    return (
      <LabeledControl label={label} isSet={isSet}>
        <Input
          ref={inputRef}
          fieldSize="sm"
          aria-label={`${ariaLabel} (custom)`}
          placeholder="repeat(3, 1fr) · 200px 1fr · …"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDraft()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelDraft()
            }
          }}
        />
      </LabeledControl>
    )
  }

  // ── Custom-value state — chip + close ─────────────────────────────────────
  if (isCustomValue) {
    return (
      <LabeledControl label={label} isSet={isSet}>
        <div className={styles.displayChipGroup}>
          <Button
            variant="secondary"
            size="sm"
            fullWidth
            align="start"
            aria-label={`${ariaLabel}: ${value}`}
            tooltip="Edit track template"
            className={styles.displayChip}
            onClick={enterEditMode}
          >
            <span className={styles.displayChipValue}>{value}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            iconOnly
            aria-label={`Clear ${ariaLabel}`}
            tooltip={`Clear ${label.toLowerCase()}`}
            className={styles.displayChipClear}
            onClick={onClear}
          >
            <CloseIcon size={14} color="currentColor" />
          </Button>
        </div>
      </LabeledControl>
    )
  }

  // ── Preset-count state — segmented [2 | 3 | 4 | 5 | 6 | ⋯] ─────────────
  return (
    <LabeledControl label={label} isSet={isSet}>
      <SegmentedControl
        size="sm"
        fullWidth
        aria-label={ariaLabel}
        value={isPreset ? String(presetN) : undefined}
        onChange={(s) => onChange(`repeat(${s}, 1fr)`)}
        onClear={onClear}
        options={GRID_PRESETS.map((n) => ({
          value: String(n),
          label: String(n),
          ariaLabel: `${n} tracks`,
          tooltip: `repeat(${n}, 1fr)`,
        }))}
        trailing={({ trailingClassName }) => (
          <Button
            variant="secondary"
            size="sm"
            iconOnly
            aria-label="Custom track template"
            tooltip="Custom track template"
            className={trailingClassName}
            onClick={enterEditMode}
          >
            <ChevronDownIcon size={14} color="currentColor" />
          </Button>
        )}
      />
    </LabeledControl>
  )
}

/**
 * Parse a `repeat(N, 1fr)` template into its track count `N`. Returns null
 * for any other shape (custom templates, named tracks, mixed sizing,
 * subgrid, etc.) so GridTrackControl can fall back to its custom-value
 * states. Whitespace tolerant — `repeat( 3 , 1fr )` still parses.
 */
function parseGridRepeat(value: string | undefined): number | null {
  if (!value) return null
  const m = value.trim().match(/^repeat\(\s*(\d+)\s*,\s*1fr\s*\)$/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) && n > 0 && n <= 99 ? n : null
}
