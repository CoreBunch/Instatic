/**
 * useCanvasRadiusDrag — drag one of the four corner dots inside the selection
 * to round the element's corners on the canvas (the Figma gesture). Rides the
 * shared preview/commit skeleton in `canvasStyleGesture.ts`; this file owns
 * only the corner maths.
 *
 * Pulling a dot toward the element's centre grows the radius, pushing it back
 * to the corner shrinks it: the delta is the pointer's travel projected on the
 * corner's inward diagonal (the average of its x and y components, so a move
 * straight along the diagonal by `d` changes the radius by `d`). Clamped to
 * `[0, min(width, height) / 2]` — beyond half the shorter side a radius stops
 * changing the shape.
 *
 * Which corners move follows the inspector's Radius row: its "all corners" /
 * "separately" scope is session state in the store (`radiusScope`), so a dot
 * dragged in "separately" mode rounds only its corner, and in linked mode
 * all four. Holding **Alt** flips that for the drag. Writes the
 * `border*Radius` longhands (the same keys the Radius row uses) and clears a
 * stored `borderRadius` shorthand that would otherwise shadow them.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEditorStore } from '@site/store/store'
import type { ActiveStyleTarget } from '@site/store/useActiveStyleTarget'
import type { CSSPropertyBag } from '@core/page-tree'
import { useCanvasStyleGesture } from './canvasStyleGesture'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { editCornerRadii, radiusCorners, radiusProperty, type RadiusCorner } from '@site/property-controls/cornerRadii'

/** Which way is "inward" for each corner, per axis. */
const INWARD: Record<RadiusCorner, [number, number]> = {
  nw: [1, 1],
  ne: [-1, 1],
  se: [-1, -1],
  sw: [1, -1],
}

/**
 * The element's used corner radii in CSS px, in radiusCorners order.
 * An elliptical radius (`8px 12px`) reads its horizontal component.
 */
export function readCornerRadii(computed: CSSStyleDeclaration, width: number): number[] {
  return radiusCorners.map((corner) => {
    const horizontal = computed[radiusProperty[corner]].split(' ')[0]
    const value = Number.parseFloat(horizontal) || 0
    return horizontal.endsWith('%') ? value * width / 100 : value
  })
}

interface UseCanvasRadiusDragOptions {
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
}

export function useCanvasRadiusDrag({ iframeElement, styleTarget }: UseCanvasRadiusDragOptions) {
  const capture = useCanvasStyleGesture(styleTarget?.key)
  const begin = (event: ReactPointerEvent<HTMLElement>, corner: RadiusCorner): void => {
    const { selectedNodeIds, radiusScope } = useEditorStore.getState()
    const doc = iframeElement?.contentDocument
    if (!iframeElement || !styleTarget || !doc?.defaultView || selectedNodeIds.length !== 1) return
    const element = doc.querySelector<HTMLElement>(`[data-node-id="${escapeCssAttributeValue(selectedNodeIds[0])}"]`)
    if (!element) return

    const bounds = element.getBoundingClientRect()
    const computed = doc.defaultView.getComputedStyle(element)
    const radii = readCornerRadii(computed, bounds.width)
    const startRadius = radii[radiusCorners.indexOf(corner)]
    const scope = radiusScope ?? (radii.some((r) => r !== radii[0]) ? 'parts' : 'all')
    const single = (scope === 'parts') !== event.altKey
    const maxRadius = Math.min(bounds.width, bounds.height) / 2
    const [sx, sy] = INWARD[corner]
    const scale = iframeElement.getBoundingClientRect().width / iframeElement.offsetWidth
    if (!scale) return

    const startX = event.clientX
    const startY = event.clientY
    let last: Partial<CSSPropertyBag> | null = null
    capture(event, {
      move(move) {
        const delta = (sx * (move.clientX - startX) + sy * (move.clientY - startY)) / (2 * scale)
        const radius = Math.min(maxRadius, Math.max(0, Math.round(startRadius + delta)))
        const patch = editCornerRadii(styleTarget.stored, `${radius}px`, single ? corner : undefined)
        last = patch
        styleTarget.previewStyles(patch)
      },
      end() {
        if (last) styleTarget.writeStyles(last)
        styleTarget.clearPreview()
      },
      cancel: styleTarget.clearPreview,
    })
  }

  return { begin }
}
