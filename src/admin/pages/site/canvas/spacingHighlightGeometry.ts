/**
 * Pure geometry for the live spacing highlight (SpacingHighlightOverlay).
 * Split from the component so it stays unit-testable and the component file
 * exports only the component (react-refresh contract) — same arrangement as
 * gradientGizmoGeometry.ts next to CanvasGradientGizmo.
 */

import type { InsetSide } from '@site/store/slices/selectionSlice'

/** Rect in iframe-document coordinates (pre measure-session translation). */
export interface SpacingBandBox {
  left: number
  top: number
  width: number
  height: number
}

export interface SideWidths {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * The band rect for one spacing side, in iframe-document coordinates.
 * Margin bands attach OUTSIDE the border box (spanning its edge length);
 * padding bands attach INSIDE it, inset by the border widths.
 *
 * `thickness` is the ABSOLUTE band depth. A negative margin is drawn by
 * passing its magnitude with `negative: true`: the band flips to the other
 * side of the same edge (a `margin-top: -20px` pulls the element UP, so the
 * 20px it swallowed lies INSIDE the top of the border box, not above it).
 * Callers tint that band differently — see SpacingHighlightOverlay.
 */
export function spacingBandRect(
  box: 'margin' | 'padding',
  side: InsetSide,
  borderBox: SpacingBandBox,
  thickness: number,
  borders: SideWidths,
  negative = false,
): SpacingBandBox {
  if (box === 'margin' && negative) {
    switch (side) {
      case 'top':
        return { left: borderBox.left, top: borderBox.top, width: borderBox.width, height: thickness }
      case 'bottom':
        return {
          left: borderBox.left,
          top: borderBox.top + borderBox.height - thickness,
          width: borderBox.width,
          height: thickness,
        }
      case 'left':
        return { left: borderBox.left, top: borderBox.top, width: thickness, height: borderBox.height }
      case 'right':
        return {
          left: borderBox.left + borderBox.width - thickness,
          top: borderBox.top,
          width: thickness,
          height: borderBox.height,
        }
    }
  }
  if (box === 'margin') {
    switch (side) {
      case 'top':
        return { left: borderBox.left, top: borderBox.top - thickness, width: borderBox.width, height: thickness }
      case 'bottom':
        return { left: borderBox.left, top: borderBox.top + borderBox.height, width: borderBox.width, height: thickness }
      case 'left':
        return { left: borderBox.left - thickness, top: borderBox.top, width: thickness, height: borderBox.height }
      case 'right':
        return { left: borderBox.left + borderBox.width, top: borderBox.top, width: thickness, height: borderBox.height }
    }
  }
  const inner = {
    left: borderBox.left + borders.left,
    top: borderBox.top + borders.top,
    width: Math.max(borderBox.width - borders.left - borders.right, 0),
    height: Math.max(borderBox.height - borders.top - borders.bottom, 0),
  }
  switch (side) {
    case 'top':
      return { left: inner.left, top: inner.top, width: inner.width, height: thickness }
    case 'bottom':
      return { left: inner.left, top: inner.top + inner.height - thickness, width: inner.width, height: thickness }
    case 'left':
      return { left: inner.left, top: inner.top, width: thickness, height: inner.height }
    case 'right':
      return { left: inner.left + inner.width - thickness, top: inner.top, width: thickness, height: inner.height }
  }
}
