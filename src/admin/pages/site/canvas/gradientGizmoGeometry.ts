/**
 * Geometry for the on-canvas gradient gizmo — the axis line drawn across the
 * selected element with one draggable handle per colour stop.
 *
 * Pure functions over plain numbers: no DOM, no React. The gizmo component
 * measures the element into canvas-overlay coordinates and then only talks to
 * this module, which keeps the tricky part (CSS's gradient-line definition)
 * testable without a browser.
 *
 * The CSS gradient line
 * ─────────────────────
 * `linear-gradient(θdeg, …)` does NOT run corner to corner. Per CSS Images 3
 * §3.4.1 the line passes through the box centre at angle θ measured CLOCKWISE
 * from "to top", and its length is
 *
 *     L = |w · sin θ| + |h · cos θ|
 *
 * — chosen so the perpendicular through each end passes exactly through the
 * nearest corner, i.e. the 0% and 100% stops land where the gradient actually
 * starts and finishes. Using the box diagonal (the obvious guess) puts the
 * handles off the real endpoints at every angle except the diagonals.
 *
 * Screen coordinates have y pointing DOWN while CSS angles are measured from
 * "up", so the unit direction for θ is `(sin θ, −cos θ)`.
 */

export interface GizmoPoint {
  x: number
  y: number
}

export interface GizmoRect {
  x: number
  y: number
  width: number
  height: number
}

export interface GradientAxis {
  start: GizmoPoint
  end: GizmoPoint
  center: GizmoPoint
  /** Length of the CSS gradient line, in the same px space as the rect. */
  length: number
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

export function normalizeAngle(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  return ((degrees % 360) + 360) % 360
}

/** The unit vector a CSS gradient at `angleDeg` travels along, in screen px. */
export function gradientDirection(angleDeg: number): GizmoPoint {
  const radians = toRadians(normalizeAngle(angleDeg))
  return { x: Math.sin(radians), y: -Math.cos(radians) }
}

/** Resolve the CSS gradient line for a box, in canvas-overlay coordinates. */
export function gradientAxis(rect: GizmoRect, angleDeg: number): GradientAxis {
  const radians = toRadians(normalizeAngle(angleDeg))
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  const length =
    Math.abs(rect.width * Math.sin(radians)) + Math.abs(rect.height * Math.cos(radians))
  const direction = gradientDirection(angleDeg)
  const half = length / 2
  return {
    start: { x: center.x - direction.x * half, y: center.y - direction.y * half },
    end: { x: center.x + direction.x * half, y: center.y + direction.y * half },
    center,
    length,
  }
}

/** Where a stop at `pos` (0–1) sits along the axis. */
export function stopPoint(axis: GradientAxis, pos: number): GizmoPoint {
  const clamped = Math.min(1, Math.max(0, pos))
  return {
    x: axis.start.x + (axis.end.x - axis.start.x) * clamped,
    y: axis.start.y + (axis.end.y - axis.start.y) * clamped,
  }
}

/**
 * Project an arbitrary point onto the axis and return its 0–1 position.
 * The pointer never has to stay ON the thin line while dragging — anywhere
 * perpendicular to it maps to the same stop position, which is what makes
 * the handles feel forgiving.
 */
export function posFromPoint(axis: GradientAxis, point: GizmoPoint): number {
  if (axis.length === 0) return 0
  const axisX = axis.end.x - axis.start.x
  const axisY = axis.end.y - axis.start.y
  const projected =
    ((point.x - axis.start.x) * axisX + (point.y - axis.start.y) * axisY) /
    (axis.length * axis.length)
  return Math.min(1, Math.max(0, projected))
}

/**
 * The CSS angle that points from `center` toward `point`. Inverse of
 * `gradientDirection` — dragging an end cap rotates the gradient to follow
 * the pointer.
 */
export function angleFromPoint(center: GizmoPoint, point: GizmoPoint): number {
  const dx = point.x - center.x
  const dy = point.y - center.y
  if (dx === 0 && dy === 0) return 0
  return normalizeAngle((Math.atan2(dx, -dy) * 180) / Math.PI)
}

/** Snap to 15° increments — the Shift-drag affordance every editor has. */
export function snapAngle(degrees: number, step = 15): number {
  return normalizeAngle(Math.round(normalizeAngle(degrees) / step) * step)
}
