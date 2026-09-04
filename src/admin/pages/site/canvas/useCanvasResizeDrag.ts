/**
 * useCanvasResizeDrag — drag one of the eight selection handles to resize
 * the selected element on the canvas. Rides the shared preview/commit
 * skeleton in `canvasStyleGesture.ts`; this file owns only the axis maths.
 *
 * Axis semantics: E/W handles write `width`, N/S write `height`, corners
 * write both. On a positioned element (relative / absolute / fixed) the W
 * and N handles also shift `left` / `top` so the grabbed edge follows the
 * pointer while the opposite edge stays put; on a static element they
 * resize from the opposite edge (the element stays in flow).
 *
 * Ratio: the inspector's Size lock (`sizeRatioLocked` in the store) makes the
 * drag keep the element's width:height — an edge handle derives the other
 * dimension, a corner follows whichever axis the pointer moved more. Shift
 * flips the lock for one drag, so an unlocked element can be scaled
 * proportionally and a locked one freed without a trip to the panel.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import type { CSSPropertyBag } from '@core/page-tree'
import { beginCanvasStyleGesture, parsePx } from './canvasStyleGesture'
import type { ResizeHandleDirection } from './canvasSelectionOverlayPositioning'

const POSITIONED = new Set(['relative', 'absolute', 'fixed'])
const MIN_SIZE_PX = 4

interface UseCanvasResizeDragOptions {
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
}

export function useCanvasResizeDrag({
  iframeElement,
  styleTarget,
}: UseCanvasResizeDragOptions) {
  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    direction: ResizeHandleDirection,
  ): void => {
    const keepRatio = useEditorStore.getState().sizeRatioLocked !== Boolean(event.shiftKey)

    beginCanvasStyleGesture({
      event,
      iframeElement,
      styleTarget,
      blockedHint: 'Add a class to this element to resize it per breakpoint.',
      start: ({ computed }) => {
        const positioned = POSITIONED.has(computed.position)

        const grabsX = direction.includes('e') || direction.includes('w')
        const grabsY = direction.includes('n') || direction.includes('s')
        // W/N grow leftward/upward: the delta flips, and on positioned
        // elements the same delta shifts left/top so the grabbed edge follows
        // the pointer.
        const signX = direction.includes('w') ? -1 : 1
        const signY = direction.includes('n') ? -1 : 1
        const shiftsLeft = positioned && direction.includes('w')
        const shiftsTop = positioned && direction.includes('n')

        // Computed width/height are used values in px, already expressed
        // against the element's own box-sizing — writing them back is
        // size-preserving.
        const startW = parsePx(computed.width)
        const startH = parsePx(computed.height)
        const startLeft = parsePx(computed.left)
        const startTop = parsePx(computed.top)
        // A zero side has no ratio to keep — fall back to a free resize.
        const ratio = keepRatio && startW > 0 && startH > 0 ? startW / startH : null
        const writesX = grabsX || ratio !== null
        const writesY = grabsY || ratio !== null

        return {
          touchedProps: [
            ...(writesX ? ['width'] : []),
            ...(writesY ? ['height'] : []),
            ...(shiftsLeft ? ['left'] : []),
            ...(shiftsTop ? ['top'] : []),
          ],
          patchFor: (dx, dy) => {
            let w = grabsX ? Math.max(MIN_SIZE_PX, startW + dx * signX) : startW
            let h = grabsY ? Math.max(MIN_SIZE_PX, startH + dy * signY) : startH
            if (ratio !== null) {
              // The axis the pointer moved more leads; the other follows.
              const leadX = grabsX && (!grabsY || Math.abs(dx) >= Math.abs(dy))
              if (leadX) h = Math.max(MIN_SIZE_PX, w / ratio)
              else w = Math.max(MIN_SIZE_PX, h * ratio)
            }
            w = Math.round(w)
            h = Math.round(h)

            const patch: Partial<CSSPropertyBag> = {}
            if (writesX) {
              patch.width = `${w}px`
              if (shiftsLeft) patch.left = `${Math.round(startLeft + (startW - w))}px`
            }
            if (writesY) {
              patch.height = `${h}px`
              if (shiftsTop) patch.top = `${Math.round(startTop + (startH - h))}px`
            }
            return patch
          },
        }
      },
    })
  }

  return { begin }
}
