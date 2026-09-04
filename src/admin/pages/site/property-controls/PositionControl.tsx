/**
 * PositionControl — a CSS `<position>` (`object-position`,
 * `background-position`) as something to CLICK, not a phrase to know.
 *
 * The row shows the value as a field. Clicking it opens a popout — the same
 * FloatingPanel the effects use — with a 3×3 grid of anchor tiles
 * (left / center / right × top / center / bottom) and two UnitFields for a
 * custom X / Y offset. Tiles commit keywords (`left top`); the fields commit
 * lengths (`20% 80%`). A tile reads as pressed when the stored value resolves
 * to its anchor, whether written as the keyword or its percentage
 * (`0% 0%` is `left top`). Hovering a tile previews it on the canvas.
 */

import { useRef, useState } from 'react'
import { Button } from '@ui/components/Button'
import { ControlRow } from '@ui/components/ControlRow'
import { FloatingPanel } from '@ui/components/FloatingPanel'
import { cn } from '@ui/cn'
import type { ControlProps } from './shared'
import { UnitField } from './UnitField'
import styles from './PositionControl.module.css'

const X_ANCHORS = ['left', 'center', 'right'] as const
const Y_ANCHORS = ['top', 'center', 'bottom'] as const
type XAnchor = (typeof X_ANCHORS)[number]
type YAnchor = (typeof Y_ANCHORS)[number]

/** Keyword ⇄ percentage: what each anchor means as a length. */
const ANCHOR_PERCENT: Record<XAnchor | YAnchor, string> = {
  left: '0%',
  top: '0%',
  center: '50%',
  right: '100%',
  bottom: '100%',
}

const OFFSET_UNITS = ['%', 'px', 'em', 'rem'] as const

interface Position {
  x: string
  y: string
}

/**
 * Split a `<position>` into its two axis tokens. One token is the horizontal
 * axis unless it is a vertical keyword (`top` alone means `center top`);
 * the other axis defaults to `center`, as in CSS.
 */
function parsePosition(raw: string): Position {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { x: 'center', y: 'center' }
  if (tokens.length === 1) {
    const token = tokens[0].toLowerCase()
    return token === 'top' || token === 'bottom'
      ? { x: 'center', y: token }
      : { x: token, y: 'center' }
  }
  return { x: tokens[0].toLowerCase(), y: tokens[1].toLowerCase() }
}

function xAnchorOf(token: string): XAnchor | null {
  for (const anchor of X_ANCHORS) {
    if (token === anchor || token === ANCHOR_PERCENT[anchor]) return anchor
  }
  return null
}

function yAnchorOf(token: string): YAnchor | null {
  for (const anchor of Y_ANCHORS) {
    if (token === anchor || token === ANCHOR_PERCENT[anchor]) return anchor
  }
  return null
}

/** A length the UnitField can edit; keywords show as their percentage placeholder. */
function axisLength(token: string): string | undefined {
  return xAnchorOf(token) || yAnchorOf(token) ? undefined : token
}

function axisPlaceholder(token: string): string {
  const anchor = xAnchorOf(token) ?? yAnchorOf(token)
  return anchor ? ANCHOR_PERCENT[anchor] : '50%'
}

interface PositionControlProps extends ControlProps<string> {
  placeholder?: string
  onPreview?: (propKey: string, value: string) => void
  onClearPreview?: () => void
}

export function PositionControl({
  propKey,
  value,
  placeholder,
  label,
  isOverride,
  disabled,
  onChange,
  onPreview,
  onClearPreview,
}: PositionControlProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const title = label ?? propKey
  // An unset row edits from its effective value, so the first tile click is a
  // change relative to what the canvas shows, not to a blank.
  const position = parsePosition(value || placeholder || '')
  const pressedX = xAnchorOf(position.x)
  const pressedY = yAnchorOf(position.y)

  const commit = (next: Position) => onChange(propKey, `${next.x} ${next.y}`)

  return (
    <ControlRow propKey={propKey} label={title} isOverride={isOverride} disabled={disabled}>
      {/* The trigger IS the field: it shows the value and opens the grid. */}
      <Button
        ref={triggerRef}
        variant="ghost"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${title} — edit`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={cn(styles.value, !value && styles.valuePlaceholder)}>
          {value || placeholder || 'center center'}
        </span>
      </Button>
      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        title={title}
        closeLabel={`Close ${title} editor`}
        estimatedHeight={220}
      >
        <div className={styles.params}>
          <div className={styles.grid} role="group" aria-label={`${title} anchor`}>
            {Y_ANCHORS.map((y) =>
              X_ANCHORS.map((x) => {
                const pressed = pressedX === x && pressedY === y
                return (
                  <Button
                    key={`${x}-${y}`}
                    variant="ghost"
                    className={styles.tile}
                    aria-pressed={pressed}
                    aria-label={`${x} ${y}`}
                    onMouseEnter={onPreview ? () => onPreview(propKey, `${x} ${y}`) : undefined}
                    onMouseLeave={onClearPreview}
                    onClick={() => {
                      onClearPreview?.()
                      commit({ x, y })
                    }}
                  >
                    <span className={styles.dot} aria-hidden="true" />
                  </Button>
                )
              }),
            )}
          </div>
          <ControlRow propKey={`${propKey}-x`} label="X" narrow>
            <UnitField
              fieldSize="xs"
              aria-label={`${title} X`}
              value={axisLength(position.x)}
              placeholder={axisPlaceholder(position.x)}
              units={OFFSET_UNITS}
              keywords={[]}
              onCommit={(raw) => commit({ x: raw ?? 'center', y: position.y })}
              onPreview={
                onPreview ? (raw) => onPreview(propKey, `${raw ?? 'center'} ${position.y}`) : undefined
              }
              onClearPreview={onClearPreview}
            />
          </ControlRow>
          <ControlRow propKey={`${propKey}-y`} label="Y" narrow>
            <UnitField
              fieldSize="xs"
              aria-label={`${title} Y`}
              value={axisLength(position.y)}
              placeholder={axisPlaceholder(position.y)}
              units={OFFSET_UNITS}
              keywords={[]}
              onCommit={(raw) => commit({ x: position.x, y: raw ?? 'center' })}
              onPreview={
                onPreview ? (raw) => onPreview(propKey, `${position.x} ${raw ?? 'center'}`) : undefined
              }
              onClearPreview={onClearPreview}
            />
          </ControlRow>
        </div>
      </FloatingPanel>
    </ControlRow>
  )
}
