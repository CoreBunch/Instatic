/**
 * Canvas coordinate math — pure functions, zero side effects.
 *
 * Transform model: `translate(panX, panY) scale(zoom)`
 * → a point at canvas coords (cx, cy) appears at screen coords (cx*zoom + panX, cy*zoom + panY)
 *
 * Exported as named exports so performance regression tests can time them directly.
 * See Contribution #311 (perf regression suite) — imports from './math'.
 */

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4
/** Zoom the design canvas opens at — 50% keeps several breakpoint frames in view. */
export const INITIAL_ZOOM = 0.5
/** Zoom that "reset view" (Cmd/Ctrl+0, the toolbar % button) returns to. */
export const RESET_ZOOM = 1

/**
 * Maximum pan offset in each direction (pixels in document space).
 * Belt-and-suspenders guard against agent tool writes that bypass call-site guards.
 * Architecture spec: Contribution #435, Security Auditor review (message #1270).
 */
export const MAX_PAN = 50_000

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const

/** Clamp zoom to valid range. */
export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
}

/** Clamp a pan value to [-MAX_PAN, MAX_PAN]. */
export function clampPan(v: number): number {
  return Math.max(-MAX_PAN, Math.min(MAX_PAN, v))
}

/** Step zoom up (1) or down (-1) to the next preset level. */
export function nearestZoomStep(current: number, direction: 1 | -1): number {
  if (direction === 1) {
    return ZOOM_STEPS.find((z) => z > current + 1e-9) ?? MAX_ZOOM
  }
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-9) ?? MIN_ZOOM
}

/**
 * Convert a screen-space point to canvas-space coordinates.
 *
 * @param sx     Screen X (relative to canvas element top-left)
 * @param sy     Screen Y (relative to canvas element top-left)
 * @param zoom   Current zoom level
 * @param panX   Current X pan offset (screen-space)
 * @param panY   Current Y pan offset (screen-space)
 */
export function screenToCanvas(
  sx: number,
  sy: number,
  zoom: number,
  panX: number,
  panY: number,
): { x: number; y: number } {
  return {
    x: (sx - panX) / zoom,
    y: (sy - panY) / zoom,
  }
}

/**
 * Convert a canvas-space point to screen-space coordinates.
 */
export function canvasToScreen(
  cx: number,
  cy: number,
  zoom: number,
  panX: number,
  panY: number,
): { x: number; y: number } {
  return {
    x: cx * zoom + panX,
    y: cy * zoom + panY,
  }
}

/**
 * Compute new transform after a zoom operation, keeping `originX/originY`
 * (in screen-space, relative to canvas element) fixed.
 *
 * Used for Ctrl+Wheel zoom and pinch-to-zoom.
 */
export function applyZoom(
  currentZoom: number,
  newZoom: number,
  originX: number,
  originY: number,
  panX: number,
  panY: number,
): { zoom: number; panX: number; panY: number } {
  const clamped = clampZoom(newZoom)
  const scale = clamped / currentZoom
  return {
    zoom: clamped,
    panX: originX - scale * (originX - panX),
    panY: originY - scale * (originY - panY),
  }
}

/**
 * Compute new pan offset after a pan delta.
 * Separated from applyZoom so they can be composed or called independently.
 */
export function applyPan(
  panX: number,
  panY: number,
  dx: number,
  dy: number,
): { panX: number; panY: number } {
  return { panX: panX + dx, panY: panY + dy }
}

/**
 * Convert @use-gesture's accumulated pinch scale into a per-event multiplier.
 *
 * For pinch gestures, movement[0] is the scale ratio since gesture start, not
 * the delta from the previous frame. Applying it directly every frame compounds
 * zoom and makes small gestures race toward MIN_ZOOM / MAX_ZOOM.
 */
export function incrementalScaleFromPinchMovement(
  currentMovement: number,
  previousMovement: number,
): number {
  if (
    !Number.isFinite(currentMovement) ||
    !Number.isFinite(previousMovement) ||
    currentMovement <= 0 ||
    previousMovement <= 0
  ) {
    return 1
  }

  return currentMovement / previousMovement
}

/**
 * Compute zoom factor from a wheel event delta.
 * `deltaY > 0` = scroll down = zoom out.
 * Sensitivity: 0.15% per pixel delta (smooth trackpad) or ~15% per wheel notch.
 */
export function zoomFromWheelDelta(currentZoom: number, deltaY: number): number {
  const factor = Math.pow(0.9985, deltaY)
  return clampZoom(currentZoom * factor)
}

