/**
 * sideScrub — drag a spacing-box band segment to scrub its side's value.
 *
 * The segments have worn per-side resize cursors (`n/e/s/w-resize`) since the
 * redesign; this module supplies the gesture the cursor promises. Dragging
 * AWAY from the element's centre increases the value on every side, so the
 * motion always reads as "push the edge outward".
 *
 * Gesture contract (same preview/commit split as the canvas drags):
 *   - A press is NOT a scrub until the pointer travels the threshold, so
 *     clicking a band still focuses its input and opens the value editor.
 *   - While scrubbing, only the preview channel fires (canvas + field drafts
 *     update live); ONE commit lands on release. Escape cancels — preview
 *     cleared, nothing committed, and the trailing click is swallowed.
 *   - Pointer capture keeps the stream alive outside the band; pointercancel
 *     tears down cleanly. The scrub survives fast pointers and never leaves
 *     a stale preview behind — every exit path runs the same teardown.
 *
 * Value semantics: the side's current number scrubs 1 CSS unit per pixel
 * (em/rem: 0.125 per pixel — one step per 8px, matching the popout slider's
 * step), Shift is ×10. A non-numeric start (`auto`, `var(--…)`, empty) scrubs
 * from 0px — an explicit drag means "give me a number".
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { displayTokenValue, type Token } from '@site/property-controls/tokenUtils'

/** Pointer travel before a press becomes a scrub instead of a click. */
const SCRUB_THRESHOLD_PX = 3
const SHIFT_MULTIPLIER = 10

const NUMERIC_RE = /^(-?\d*\.?\d+)([a-z%]*)$/i

type ScrubSide = 'top' | 'right' | 'bottom' | 'left'

interface SideScrubOptions {
  side: ScrubSide
  /** The side's current raw value (`'18px'`, `'auto'`, `''`, `var(--…)`). */
  startRaw: string
  /** Margins go negative; padding is floored at 0 (invalid CSS otherwise). */
  allowNegative: boolean
  onPreview: (resolved: string) => void
  onCommit: (resolved: string) => void
  onCancel: () => void
}

function parseStart(raw: string): { value: number; unit: string } {
  const match = NUMERIC_RE.exec(raw.trim())
  if (!match) return { value: 0, unit: 'px' }
  return { value: Number(match[1]), unit: match[2].toLowerCase() || 'px' }
}

/** Drag distance → value delta, oriented so "away from centre" increases. */
function axisDelta(side: ScrubSide, dx: number, dy: number): number {
  switch (side) {
    case 'top':
      return -dy
    case 'bottom':
      return dy
    case 'left':
      return -dx
    case 'right':
      return dx
  }
}

/** Strip float junk: 0.30000000000000004 → 0.3. */
function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

export function beginSideScrub(
  event: ReactPointerEvent<HTMLElement>,
  { side, startRaw, allowNegative, onPreview, onCommit, onCancel }: SideScrubOptions,
): void {
  if (event.button !== 0) return

  const label = event.currentTarget
  const { value: startValue, unit } = parseStart(startRaw)
  // em/rem step an eighth per pixel; everything px-like scrubs 1:1.
  const perPixel = unit === 'em' || unit === 'rem' ? 0.125 : 1
  const startX = event.clientX
  const startY = event.clientY
  const pointerId = event.pointerId

  let armed = false
  let last: string | null = null

  const swallowNextClick = () => {
    // The release still dispatches a click on the label, which would focus
    // the input and pop the value editor open mid-gesture-end. Swallow that
    // one click; the timeout drops the guard if no click arrives (pointer
    // released off-label), so a later legit click still works.
    const swallow = (click: Event) => {
      click.preventDefault()
      click.stopPropagation()
    }
    label.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => label.removeEventListener('click', swallow, { capture: true }), 0)
  }

  const teardown = () => {
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleCancel)
    window.removeEventListener('keydown', handleKey, true)
    document.documentElement.style.removeProperty('cursor')
    try {
      label.releasePointerCapture(pointerId)
    } catch {
      // Already released, or the environment never granted the capture.
    }
  }

  const handleMove = (move: PointerEvent) => {
    const dx = move.clientX - startX
    const dy = move.clientY - startY
    if (!armed) {
      if (Math.abs(dx) < SCRUB_THRESHOLD_PX && Math.abs(dy) < SCRUB_THRESHOLD_PX) return
      armed = true
      try {
        label.setPointerCapture(pointerId)
      } catch {
        // Test envs reject capture; window listeners carry the gesture.
      }
      // Keep the side's resize cursor everywhere while the gesture runs.
      document.documentElement.style.cursor = getComputedStyle(label).cursor
      document.getSelection()?.removeAllRanges()
    }
    move.preventDefault()
    const delta = axisDelta(side, dx, dy) * perPixel * (move.shiftKey ? SHIFT_MULTIPLIER : 1)
    let next = startValue + delta
    if (!allowNegative && next < 0) next = 0
    if (perPixel === 1) next = Math.round(next)
    const resolved = `${fmt(next)}${unit}`
    if (resolved === last) return
    last = resolved
    onPreview(resolved)
  }

  const handleUp = () => {
    teardown()
    if (!armed) return
    swallowNextClick()
    if (last !== null) onCommit(last)
    else onCancel()
  }

  const handleCancel = () => {
    teardown()
    if (armed) swallowNextClick()
    onCancel()
  }

  const handleKey = (key: KeyboardEvent) => {
    if (key.key !== 'Escape') return
    key.stopPropagation()
    handleCancel()
  }

  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp)
  window.addEventListener('pointercancel', handleCancel)
  window.addEventListener('keydown', handleKey, true)
}

/**
 * Character count of the text a side field will actually render (tokens show
 * their short step, a bare px value drops the unit). Drives `--side-chars` on
 * the box so the horizontal band widens with its widest left/right value
 * instead of letting "1093" spill across the trapezoid edge. Lives here (not
 * in the component file) for the react-refresh only-export-components rule.
 */
export function sideDisplayChars(raw: string, tokens: ReadonlyArray<Token>): number {
  const display = displayTokenValue(raw, tokens)
  const match = display.match(/^(-?\d+(?:\.\d+)?)px$/i)
  return (match ? match[1] : display).length
}
