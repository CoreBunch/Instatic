/**
 * Gradient gizmo geometry — the axis the on-canvas handles ride.
 *
 * The stake here is that the handles land where the gradient VISIBLY starts
 * and ends. CSS defines the gradient line's length as
 * `|w·sinθ| + |h·cosθ|`, not the box diagonal, so a plausible-looking
 * diagonal implementation would misplace every handle at every angle except
 * the exact diagonals — which is why these cases pin non-diagonal angles too.
 */
import { describe, expect, it } from 'bun:test'
import {
  angleFromPoint,
  gradientAxis,
  gradientDirection,
  normalizeAngle,
  posFromPoint,
  rotationCapPoint,
  snapAngle,
  stopPoint,
} from '@site/canvas/gradientGizmoGeometry'

const RECT = { x: 0, y: 0, width: 200, height: 100 }

describe('gradientDirection', () => {
  it('points up at 0deg and down at 180deg (CSS angles, screen y-down)', () => {
    const up = gradientDirection(0)
    expect(up.x).toBeCloseTo(0, 6)
    expect(up.y).toBeCloseTo(-1, 6)

    const down = gradientDirection(180)
    expect(down.x).toBeCloseTo(0, 6)
    expect(down.y).toBeCloseTo(1, 6)
  })

  it('points right at 90deg', () => {
    const right = gradientDirection(90)
    expect(right.x).toBeCloseTo(1, 6)
    expect(right.y).toBeCloseTo(0, 6)
  })
})

describe('gradientAxis', () => {
  it('spans the box height for a vertical gradient', () => {
    const axis = gradientAxis(RECT, 180)
    expect(axis.length).toBeCloseTo(100, 6)
    expect(axis.start.y).toBeCloseTo(0, 6)
    expect(axis.end.y).toBeCloseTo(100, 6)
    expect(axis.center).toEqual({ x: 100, y: 50 })
  })

  it('spans the box width for a horizontal gradient', () => {
    const axis = gradientAxis(RECT, 90)
    expect(axis.length).toBeCloseTo(200, 6)
    expect(axis.start.x).toBeCloseTo(0, 6)
    expect(axis.end.x).toBeCloseTo(200, 6)
  })

  it('uses the CSS gradient-line length at an oblique angle, NOT the diagonal', () => {
    // |200·sin45| + |100·cos45| = (200 + 100)/√2 ≈ 212.13.
    // The box diagonal would be √(200² + 100²) ≈ 223.6 — a different line.
    const axis = gradientAxis(RECT, 45)
    expect(axis.length).toBeCloseTo(212.132, 3)
    expect(axis.length).not.toBeCloseTo(223.607, 3)
  })
})

describe('stopPoint / posFromPoint', () => {
  it('round-trips a position through the axis', () => {
    const axis = gradientAxis(RECT, 135)
    for (const pos of [0, 0.25, 0.5, 0.78, 1]) {
      expect(posFromPoint(axis, stopPoint(axis, pos))).toBeCloseTo(pos, 6)
    }
  })

  it('projects a point off the line onto it, so dragging stays forgiving', () => {
    const axis = gradientAxis(RECT, 180) // vertical line at x = 100
    // 60px to the side of the line, halfway down: still the midpoint stop.
    expect(posFromPoint(axis, { x: 160, y: 50 })).toBeCloseTo(0.5, 6)
  })

  it('clamps beyond either end', () => {
    const axis = gradientAxis(RECT, 180)
    expect(posFromPoint(axis, { x: 100, y: -500 })).toBe(0)
    expect(posFromPoint(axis, { x: 100, y: 900 })).toBe(1)
  })
})

describe('angleFromPoint', () => {
  it('inverts gradientDirection', () => {
    const center = { x: 100, y: 50 }
    for (const angle of [0, 45, 90, 137, 180, 270, 315]) {
      const direction = gradientDirection(angle)
      const point = { x: center.x + direction.x * 80, y: center.y + direction.y * 80 }
      expect(angleFromPoint(center, point)).toBeCloseTo(angle, 4)
    }
  })
})

describe('rotationCapPoint', () => {
  it('sits offset px past the axis end, along the axis direction', () => {
    const axis = gradientAxis(RECT, 90) // horizontal: start left, end right
    const cap = rotationCapPoint(axis, 18)
    expect(cap.x).toBeCloseTo(axis.end.x + 18, 4)
    expect(cap.y).toBeCloseTo(axis.end.y, 4)
  })

  it('pushes straight up for a degenerate zero-length axis', () => {
    const axis = gradientAxis({ x: 10, y: 10, width: 0, height: 0 }, 45)
    const cap = rotationCapPoint(axis, 18)
    expect(cap).toEqual({ x: axis.end.x, y: axis.end.y - 18 })
  })
})

describe('snapAngle', () => {
  it('snaps to the nearest 15deg and wraps', () => {
    expect(snapAngle(97)).toBe(90)
    expect(snapAngle(98)).toBe(105)
    expect(snapAngle(-10)).toBe(345)
    expect(snapAngle(359)).toBe(0)
  })
})

/**
 * The gizmo rotates by OFFSET, not by the absolute centre→pointer angle: the
 * axis is grabbable along its whole length, and its start half points the
 * opposite way to the gradient. Reading the angle absolutely flips the fill
 * 180° the instant such a grab moves, so these pin the offset arithmetic the
 * component runs (angleOffset in beginDrag + its use in flush).
 */
describe('rotation by pointer offset', () => {
  const ANGLE = 90
  const axis = gradientAxis(RECT, ANGLE)
  /** Grab a third of the way along — on the start half, where the naive read flips. */
  const grab = stopPoint(axis, 1 / 3)
  const offset = ANGLE - angleFromPoint(axis.center, grab)

  /** Rotate a point `degrees` clockwise on screen about the axis centre. */
  function rotateAboutCenter(point: { x: number; y: number }, degrees: number) {
    const radians = (degrees * Math.PI) / 180
    const dx = point.x - axis.center.x
    const dy = point.y - axis.center.y
    return {
      x: axis.center.x + dx * Math.cos(radians) - dy * Math.sin(radians),
      y: axis.center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    }
  }

  it('holds the angle still when the axis is grabbed short of its end', () => {
    // The absolute read would say 270 here — the flip this offset exists to stop.
    expect(angleFromPoint(axis.center, grab)).toBeCloseTo(270, 6)
    expect(normalizeAngle(angleFromPoint(axis.center, grab) + offset)).toBeCloseTo(ANGLE, 6)
  })

  it('turns the gradient by exactly as far as the pointer travels', () => {
    const moved = rotateAboutCenter(grab, 30)
    expect(normalizeAngle(angleFromPoint(axis.center, moved) + offset)).toBeCloseTo(120, 6)
  })

  it('leaves the end cap unaffected, because it already sits on the axis direction', () => {
    const cap = rotationCapPoint(axis, 18)
    expect(normalizeAngle(ANGLE - angleFromPoint(axis.center, cap))).toBeCloseTo(0, 6)
  })
})
