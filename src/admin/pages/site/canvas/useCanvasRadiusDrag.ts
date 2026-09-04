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
import { beginCanvasStyleGesture, kebab, parsePx } from './canvasStyleGesture'
import { RADIUS_HANDLE_CORNERS, type RadiusHandleCorner } from './canvasSelectionOverlayPositioning'

const CORNER_PROP = {
  nw: 'borderTopLeftRadius',
  ne: 'borderTopRightRadius',
  se: 'borderBottomRightRadius',
  sw: 'borderBottomLeftRadius',
} as const satisfies Record<RadiusHandleCorner, keyof CSSPropertyBag>
type CornerRadiusKey = (typeof CORNER_PROP)[RadiusHandleCorner]

/** Which way is "inward" for each corner, per axis. */
const INWARD: Record<RadiusHandleCorner, [number, number]> = {
  nw: [1, 1],
  ne: [-1, 1],
  se: [-1, -1],
  sw: [1, -1],
}

/**
 * The element's used corner radii in CSS px, in RADIUS_HANDLE_CORNERS order.
 * An elliptical radius (`8px 12px`) reads its horizontal component.
 */
export function readCornerRadii(computed: CSSStyleDeclaration): number[] {
  return RADIUS_HANDLE_CORNERS.map((corner) =>
    parsePx(computed.getPropertyValue(kebab(CORNER_PROP[corner]))),
  )
}

interface UseCanvasRadiusDragOptions {
  iframeElement: HTMLIFrameElement | null
  styleTarget: ActiveStyleTarget | null
}

export function useCanvasRadiusDrag({ iframeElement, styleTarget }: UseCanvasRadiusDragOptions) {
  const begin = (event: ReactPointerEvent<HTMLElement>, corner: RadiusHandleCorner): void => {
    beginCanvasStyleGesture({
      event,
      iframeElement,
      styleTarget,
      blockedHint: 'Add a class to this element to round its corners per breakpoint.',
      start: ({ node, computed }) => {
        const radii = readCornerRadii(computed)
        const startRadius = radii[RADIUS_HANDLE_CORNERS.indexOf(corner)]
        // Same default the Radius row shows before the user picks a scope:
        // corners that already differ are edited separately. Alt at grab
        // time flips it for the whole drag — a modifier that flips
        // mid-gesture would make the other three corners jump.
        const chosen = useEditorStore.getState().radiusScope
        const scope = chosen ?? (radii.some((r) => r !== radii[0]) ? 'parts' : 'all')
        const single = (scope === 'parts') !== Boolean(event.altKey)
        const maxRadius = Math.floor(
          Math.min(parsePx(computed.width), parsePx(computed.height)) / 2,
        )
        const [sx, sy] = INWARD[corner]
        const corners = single ? [corner] : RADIUS_HANDLE_CORNERS
        // A stored shorthand would shadow the longhands this gesture writes.
        const clearsShorthand = Boolean(
          styleTarget ? styleTarget.styles.borderRadius : node.inlineStyles?.borderRadius,
        )

        return {
          touchedProps: corners.map((c) => kebab(CORNER_PROP[c])),
          patchFor: (dx, dy) => {
            const delta = (sx * dx + sy * dy) / 2
            const radius = Math.min(maxRadius, Math.max(0, Math.round(startRadius + delta)))
            const patch: Partial<Record<CornerRadiusKey | 'borderRadius', string | undefined>> = {}
            for (const c of corners) patch[CORNER_PROP[c]] = `${radius}px`
            if (clearsShorthand) patch.borderRadius = undefined
            return patch
          },
        }
      },
    })
  }

  return { begin }
}
