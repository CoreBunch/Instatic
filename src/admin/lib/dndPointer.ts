/**
 * Pointer math shared by the editor's dnd-kit hooks (DOM panel, site
 * explorer). dnd-kit events expose the activator event + a delta, not the
 * live pointer position — these helpers reconstruct it.
 */

import type { DragEndEvent, DragMoveEvent } from '@dnd-kit/core'

export interface DragPointerPoint {
  x: number
  y: number
}

/**
 * The live pointer position for a drag event: the cached drag-start point
 * (or the activator event's position on the first call) plus the event's
 * accumulated delta. Returns `null` when the activator event carries no
 * usable coordinates (e.g. keyboard-initiated drags).
 */
export function getDragPoint(
  event: DragMoveEvent | DragEndEvent,
  startPoint: DragPointerPoint | null,
): DragPointerPoint | null {
  const start = startPoint ?? getEventPoint(event.activatorEvent)
  if (!start) return null
  return {
    x: start.x + event.delta.x,
    y: start.y + event.delta.y,
  }
}

/**
 * The pointer position carried by a raw activator event (mouse, pointer, or
 * first touch). `null` for events with no usable coordinates (keyboard).
 */
export function getEventPoint(event: Event): DragPointerPoint | null {
  if ('clientX' in event && 'clientY' in event) {
    const maybePointer = event as MouseEvent | PointerEvent
    return { x: maybePointer.clientX, y: maybePointer.clientY }
  }
  if ('touches' in event) {
    const touchEvent = event as TouchEvent
    const touch = touchEvent.touches[0] ?? touchEvent.changedTouches[0]
    return touch ? { x: touch.clientX, y: touch.clientY } : null
  }
  return null
}
