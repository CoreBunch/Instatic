/**
 * Pointer and keyboard interaction helpers shared by the picker's sliders
 * (saturation square, hue track, alpha track). Pure DOM mechanics — no
 * colour knowledge beyond the `Hsva` shape the key handlers step.
 */

import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { clamp, type Hsva } from './colorMath'

/** Arrow-key step, as a fraction of the track. Shift multiplies by 10. */
export const KEY_STEP = 0.01

/**
 * Coalesce a high-frequency stream of positions to one `apply` per animation
 * frame. Gaming mice report pointer moves at 120–250 Hz; applying each one
 * re-renders the picker AND pushes a store commit (which repaints the canvas
 * live), so anything above the display's frame rate is pure waste. The last
 * position always wins, and `flush` delivers it synchronously at drag end.
 */
function frameThrottle<T>(apply: (value: T) => void) {
  let frame = 0
  let pending: T | null = null
  return {
    push(value: T) {
      pending = value
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pending !== null) apply(pending)
        pending = null
      })
    },
    flush() {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      if (pending !== null) apply(pending)
      pending = null
    },
  }
}

/**
 * Drag within an element's own box. Pointer capture routes subsequent moves
 * back to the same element, so no window-level listeners are needed and the
 * drag survives leaving the element. Moves are frame-throttled; the press
 * itself applies immediately so the handle reacts with zero delay.
 */
export function beginDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  apply: (x: number, y: number) => void,
) {
  const element = event.currentTarget
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return
  element.setPointerCapture(event.pointerId)
  element.focus()

  const toUnit = (clientX: number, clientY: number): [number, number] => [
    clamp((clientX - rect.left) / rect.width, 0, 1),
    clamp((clientY - rect.top) / rect.height, 0, 1),
  ]
  const throttled = frameThrottle<[number, number]>(([x, y]) => apply(x, y))

  const handleMove = (move: PointerEvent) => throttled.push(toUnit(move.clientX, move.clientY))
  const handleEnd = () => {
    element.removeEventListener('pointermove', handleMove)
    element.removeEventListener('pointerup', handleEnd)
    element.removeEventListener('pointercancel', handleEnd)
    throttled.flush()
  }

  element.addEventListener('pointermove', handleMove)
  element.addEventListener('pointerup', handleEnd)
  element.addEventListener('pointercancel', handleEnd)
  apply(...toUnit(event.clientX, event.clientY))
}

export { frameThrottle }

/**
 * Leading + trailing throttle around a heavy `emit`. The first push in a
 * burst goes out immediately (single clicks stay instant); during a drag the
 * downstream update (store commit + CRDT op + live canvas repaint) runs at
 * most once per window, and `flush` delivers the last value synchronously at
 * drag end. Local optimistic state is the caller's job — only the emission
 * is throttled. Shared by the picker's `onChange` and the canvas gradient
 * gizmo's store writes.
 */
export function createEmitThrottle(windowMs: number, emit: (value: string) => void) {
  let timer: number | null = null
  let trailing: string | null = null

  const fire = () => {
    if (trailing === null) {
      timer = null
      return
    }
    const value = trailing
    trailing = null
    emit(value)
    timer = window.setTimeout(fire, windowMs)
  }

  return {
    push(value: string) {
      if (timer !== null) {
        trailing = value
        return
      }
      emit(value)
      timer = window.setTimeout(fire, windowMs)
    },
    flush() {
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      if (trailing !== null) emit(trailing)
      trailing = null
    },
  }
}

export function handleTrackKeys(
  event: KeyboardEvent<HTMLDivElement>,
  current: number,
  apply: (next: number) => void,
) {
  const delta = event.shiftKey ? KEY_STEP * 10 : KEY_STEP
  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault()
    apply(clamp(current - delta, 0, 1))
  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault()
    apply(clamp(current + delta, 0, 1))
  } else if (event.key === 'Home') {
    event.preventDefault()
    apply(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    apply(1)
  }
}

export function handleGridKeys(
  event: KeyboardEvent<HTMLDivElement>,
  hsva: Hsva,
  apply: (next: Hsva) => void,
) {
  const delta = event.shiftKey ? KEY_STEP * 10 : KEY_STEP
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    apply({ ...hsva, s: clamp(hsva.s - delta, 0, 1) })
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    apply({ ...hsva, s: clamp(hsva.s + delta, 0, 1) })
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    apply({ ...hsva, v: clamp(hsva.v + delta, 0, 1) })
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    apply({ ...hsva, v: clamp(hsva.v - delta, 0, 1) })
  }
}
