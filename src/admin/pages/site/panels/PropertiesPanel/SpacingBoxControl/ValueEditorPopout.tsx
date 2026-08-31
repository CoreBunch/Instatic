/**
 * ValueEditorPopout — the floating value editor a spacing / inset side opens
 * (docs/features/inspector-panel.md §6.6).
 *
 * Modeled on Figma's spacing popover, carried by the shared FloatingPanel so
 * it opens BESIDE the focused side input and dismisses like every other
 * inspector popout (Escape, ×, outside click). Top to bottom: a slider +
 * compact number + unit select, a preset chip grid (with `Auto` where the
 * property accepts it), and a Reset footer.
 *
 * It owns NO write path of its own: every change flows through the SAME
 * onCommit / onPreview callbacks the inline side input uses, so linked mode
 * fans out, undo granularity stays one step per release/click, and Reset is
 * the same `commit(undefined)` an emptied field performs.
 *
 * Changing the unit converts nothing — it re-labels the number (`16px` →
 * `16em`), which is how these editors behave everywhere. A value the popout
 * cannot parse into number + unit (`calc(...)`) shows a "complex value"
 * state: slider, number and presets disable; the token grid and Reset stay —
 * a token IS a value you can pick from here, so it must not lock the editor
 * that set it.
 */

import { useRef, useState, type CSSProperties, type RefObject } from 'react'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { cn } from '@ui/cn'
import type { Token } from '@site/property-controls/tokenUtils'
import styles from './ValueEditorPopout.module.css'

const UNITS = ['px', 'em', 'rem', '%', 'vw', 'vh'] as const
type Unit = (typeof UNITS)[number]

/** Sensible slider span per unit; min is 0, or −max where negatives apply. */
const SLIDER_MAX: Record<Unit, number> = { px: 512, em: 16, rem: 16, '%': 100, vw: 100, vh: 100 }
const SLIDER_STEP: Record<Unit, number> = { px: 1, em: 0.125, rem: 0.125, '%': 1, vw: 1, vh: 1 }

const PRESETS: Record<Unit, readonly number[]> = {
  px: [0, 2, 4, 8, 16, 24, 32, 64],
  em: [0, 0.125, 0.25, 0.5, 1, 2, 4, 8],
  rem: [0, 0.125, 0.25, 0.5, 1, 2, 4, 8],
  // ponytail: %-family presets are a plain quarter scale; refine if a real
  // request names better stops.
  '%': [0, 10, 25, 50, 75, 100],
  vw: [0, 10, 25, 50, 75, 100],
  vh: [0, 10, 25, 50, 75, 100],
}

type Parsed =
  | { kind: 'number'; number: number; unit: Unit }
  | { kind: 'auto' }
  | { kind: 'unset' }
  | { kind: 'complex' }

const NUMERIC_RE = /^(-?\d*\.?\d+)([a-z%]+)?$/i

function parseSideValue(raw: string): Parsed {
  const value = raw.trim()
  if (value === '') return { kind: 'unset' }
  if (value.toLowerCase() === 'auto') return { kind: 'auto' }
  const match = NUMERIC_RE.exec(value)
  if (!match) return { kind: 'complex' }
  // A bare number means px — same reading the side inputs give a typed `16`.
  const unit = (match[2] ?? 'px').toLowerCase()
  if (!(UNITS as readonly string[]).includes(unit)) return { kind: 'complex' }
  return { kind: 'number', number: Number(match[1]), unit: unit as Unit }
}

/** Strip float junk from slider math: 0.30000000000000004 → 0.3. */
function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

type SliderStyle = CSSProperties & { '--value-progress'?: string }

interface ValueEditorPopoutProps {
  open: boolean
  onClose: () => void
  /** The side input the popout opens beside; also excluded from outside-close. */
  anchorRef: RefObject<HTMLElement | null>
  /** Header text, e.g. `Margin top` / `Inset left`. */
  title: string
  /** Stored CSS value for the side (`''` when unset). */
  value: string
  /** Offer the `auto` chip (margin and inset — padding has no auto). */
  allowAuto: boolean
  /** Let the slider go negative (margins collapse, inset offsets pull past
   *  their edge). Padding cannot: negative padding is invalid CSS. */
  allowNegative: boolean
  /** Framework spacing scale, offered as a chip grid under the presets. */
  tokens: ReadonlyArray<Token>
  /** Same channel as the inline input's commit — linked fan-out included. */
  onCommit: (resolved: string | undefined) => void
  /** Transient canvas preview while sliding / hovering presets. */
  onPreview?: (resolved: string | undefined) => void
  onClearPreview?: () => void
}

export function ValueEditorPopout({
  open,
  onClose,
  anchorRef,
  title,
  value,
  allowAuto,
  allowNegative,
  tokens,
  onCommit,
  onPreview,
  onClearPreview,
}: ValueEditorPopoutProps) {
  const parsed = parseSideValue(value)
  const complex = parsed.kind === 'complex'

  // Unit is read from the value while it has one; the choice state only
  // matters for unset/auto values, where there is no unit to read.
  const [unitChoice, setUnitChoice] = useState<Unit | null>(null)
  const unit = parsed.kind === 'number' ? parsed.unit : (unitChoice ?? 'px')

  // Slider drag draft: previews while dragging, commits once on release —
  // same contract as the opacity slider in StylesSection.
  const [drag, setDrag] = useState<number | null>(null)
  const dragging = useRef(false)

  // Number field draft: commits on Enter/blur like every inspector field.
  const [numberDraft, setNumberDraft] = useState<string | null>(null)

  const max = SLIDER_MAX[unit]
  const min = allowNegative ? -max : 0
  const sliderValue =
    drag ?? (parsed.kind === 'number' ? Math.min(max, Math.max(min, parsed.number)) : 0)
  const progress = ((sliderValue - min) / (max - min)) * 100

  const commitDrag = () => {
    dragging.current = false
    if (drag === null) return
    onClearPreview?.()
    onCommit(`${fmt(drag)}${unit}`)
    setDrag(null)
  }

  const commitTyped = (raw: string) => {
    setNumberDraft(null)
    const trimmed = raw.trim()
    if (trimmed === '') return
    const n = Number(trimmed)
    if (Number.isFinite(n)) onCommit(`${fmt(n)}${unit}`)
  }

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      title={title}
      closeLabel={`Close ${title} editor`}
      width={224}
      estimatedHeight={200}
    >
      <div className={styles.body}>
        <div className={styles.sliderRow}>
          <input
            type="range"
            className={styles.slider}
            style={{ '--value-progress': `${progress}%` } as SliderStyle}
            aria-label={`${title} slider`}
            min={min}
            max={max}
            step={SLIDER_STEP[unit]}
            value={sliderValue}
            disabled={complex}
            onPointerDown={(event) => {
              dragging.current = true
              // Without capture a release outside the track never reaches
              // onPointerUp, so the drag would stay a preview until the
              // slider happened to blur — canvas moved, stored value didn't.
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onChange={(event) => {
              const next = Number(event.target.value)
              if (dragging.current) {
                setDrag(next)
                onPreview?.(`${fmt(next)}${unit}`)
              } else {
                // Keyboard steps land here — each press commits, like the
                // field steppers.
                onCommit(`${fmt(next)}${unit}`)
              }
            }}
            onPointerUp={commitDrag}
            onBlur={commitDrag}
          />
          <Input
            fieldSize="xs"
            inputMode="decimal"
            aria-label={`${title} value`}
            className={styles.numberField}
            // While the thumb moves the field reads the drag, not the stored
            // value — the whole popout shows one number, live.
            value={
              numberDraft ??
              (drag !== null ? fmt(drag) : parsed.kind === 'number' ? fmt(parsed.number) : '')
            }
            placeholder={parsed.kind === 'auto' ? 'auto' : complex ? '—' : '0'}
            disabled={complex}
            onChange={(event) => setNumberDraft(event.target.value)}
            onBlur={(event) => commitTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
            }}
          />
          <Select
            fieldSize="xs"
            aria-label={`${title} unit`}
            className={styles.unitSelect}
            value={unit}
            disabled={complex}
            options={UNITS.map((u) => ({ label: u, value: u }))}
            onChange={(event) => {
              const next = event.target.value as Unit
              setUnitChoice(next)
              // Re-label, don't convert: 16px → 16em keeps the 16.
              if (parsed.kind === 'number') onCommit(`${fmt(parsed.number)}${next}`)
            }}
          />
        </div>

        {complex ? (
          <p className={styles.complexNote}>
            Complex value — edit it in the side field itself.
          </p>
        ) : null}

        <div className={styles.chips}>
          {allowAuto ? (
            <Button
              variant="ghost"
              size="xs"
              className={cn(styles.chip, styles.chipAuto)}
              aria-pressed={parsed.kind === 'auto'}
              disabled={complex}
              onClick={() => onCommit('auto')}
            >
              Auto
            </Button>
          ) : null}
          {PRESETS[unit].map((n) => (
            <Button
              key={n}
              variant="ghost"
              size="xs"
              className={styles.chip}
              aria-pressed={parsed.kind === 'number' && parsed.number === n}
              disabled={complex}
              onMouseEnter={onPreview ? () => onPreview(`${fmt(n)}${unit}`) : undefined}
              onMouseLeave={onClearPreview}
              onClick={() => {
                onClearPreview?.()
                onCommit(`${fmt(n)}${unit}`)
              }}
            >
              {fmt(n)}
            </Button>
          ))}
        </div>

        {tokens.length > 0 ? (
          <div className={styles.tokens}>
            <span className={styles.tokensLabel}>Tokens</span>
            <div className={styles.tokenGrid}>
              {tokens.map((token) => (
                <Button
                  key={token.varName}
                  variant="ghost"
                  size="xs"
                  className={styles.chip}
                  // A token stays pickable in the complex state — it is what
                  // put the field there.
                  aria-pressed={value.trim() === token.valueExpr}
                  tooltip={token.varName}
                  onMouseEnter={onPreview ? () => onPreview(token.valueExpr) : undefined}
                  onMouseLeave={onClearPreview}
                  onClick={() => {
                    onClearPreview?.()
                    onCommit(token.valueExpr)
                  }}
                >
                  {token.step}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={styles.footer}>
          <Button
            variant="secondary"
            size="xs"
            className={styles.resetButton}
            onClick={() => onCommit(undefined)}
          >
            Reset
          </Button>
          <span className={styles.hint}>Resetting will revert to the initial value.</span>
        </div>
      </div>
    </FloatingPanel>
  )
}
