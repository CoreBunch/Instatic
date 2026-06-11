/**
 * Canvas math.ts — pure function unit tests
 *
 * Tests every exported function from
 * `src/editor/components/Canvas/math.ts`:
 *   - clampZoom
 *   - screenToCanvas
 *   - canvasToScreen
 *   - applyZoom
 *   - applyPan
 *   - zoomFromWheelDelta
 *
 * These functions are the low-level math layer consumed by `useCanvas` and
 * the canvas gesture hooks.  The pre-merge checklist in Architecture Spec
 * #435 (Decision 2) explicitly requires unit tests for coordinate conversion
 * functions — this file satisfies that requirement for math.ts.
 *
 * All functions are pure — no Zustand store required.
 *
 * @see src/editor/components/Canvas/math.ts
 * @see Contribution #435 — Phase 2 Infinite Canvas Architecture Spec (Decision 2)
 * @see Contribution #431 — Phase 2 Performance Spec (Hot Path 1 — applyZoom formula)
 */

import { describe, it, expect } from 'bun:test'
import * as canvasMath from '@site/canvas/math'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  INITIAL_ZOOM,
  RESET_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  nearestZoomStep,
  screenToCanvas,
  canvasToScreen,
  applyZoom,
  applyPan,
  zoomFromWheelDelta,
} from '@site/canvas/math'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('math.ts — exported constants', () => {
  it('MIN_ZOOM is positive', () => {
    expect(MIN_ZOOM).toBeGreaterThan(0)
  })

  it('MAX_ZOOM is greater than MIN_ZOOM', () => {
    expect(MAX_ZOOM).toBeGreaterThan(MIN_ZOOM)
  })

  it('MAX_ZOOM is a reasonable upper bound (≤ 10)', () => {
    expect(MAX_ZOOM).toBeLessThanOrEqual(10)
  })

  it('ZOOM_STEPS are ordered boundaries and include the initial + reset zooms', () => {
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM)
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(MAX_ZOOM)
    expect(ZOOM_STEPS).toContain(INITIAL_ZOOM)
    expect(ZOOM_STEPS).toContain(RESET_ZOOM)
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i]).toBeGreaterThan(ZOOM_STEPS[i - 1])
    }
  })
})

// ---------------------------------------------------------------------------
// clampZoom
// ---------------------------------------------------------------------------

describe('clampZoom', () => {
  it('returns value unchanged when within [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoom(0.5)).toBe(0.5)
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(2)).toBe(2)
    expect(clampZoom(3)).toBe(3)
  })

  it('clamps to MIN_ZOOM when input is below minimum', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(-1)).toBe(MIN_ZOOM)
    expect(clampZoom(-9999)).toBe(MIN_ZOOM)
    expect(clampZoom(MIN_ZOOM - 0.001)).toBe(MIN_ZOOM)
  })

  it('clamps to MAX_ZOOM when input is above maximum', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM)
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(MAX_ZOOM + 0.001)).toBe(MAX_ZOOM)
  })

  it('returns exactly MIN_ZOOM at the lower boundary', () => {
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM)
  })

  it('returns exactly MAX_ZOOM at the upper boundary', () => {
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM)
  })

  it('is a pure function — same input produces same output', () => {
    expect(clampZoom(1.5)).toBe(clampZoom(1.5))
  })
})

// ---------------------------------------------------------------------------
// nearestZoomStep
// ---------------------------------------------------------------------------

describe('nearestZoomStep', () => {
  it('moves to the next zoom step in the requested direction', () => {
    expect(nearestZoomStep(0.1, 1)).toBe(0.25)
    expect(nearestZoomStep(1, 1)).toBe(1.25)
    expect(nearestZoomStep(3, 1)).toBe(MAX_ZOOM)

    expect(nearestZoomStep(4, -1)).toBe(3)
    expect(nearestZoomStep(1, -1)).toBe(0.75)
    expect(nearestZoomStep(0.25, -1)).toBe(MIN_ZOOM)
  })

  it('snaps non-step values outward and clamps at the bounds', () => {
    expect(nearestZoomStep(1.1, 1)).toBe(1.25)
    expect(nearestZoomStep(1.1, -1)).toBe(1)
    expect(nearestZoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
    expect(nearestZoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })
})

// ---------------------------------------------------------------------------
// screenToCanvas
// ---------------------------------------------------------------------------

describe('screenToCanvas', () => {
  it('maps screen origin to canvas origin at zoom=1, pan=(0,0)', () => {
    const result = screenToCanvas(0, 0, 1, 0, 0)
    expect(result).toEqual({ x: 0, y: 0 })
  })

  it('is identity at zoom=1 with zero pan', () => {
    const result = screenToCanvas(100, 200, 1, 0, 0)
    expect(result).toEqual({ x: 100, y: 200 })
  })

  it('scales down by zoom (zoom=2 halves canvas coordinates)', () => {
    const result = screenToCanvas(200, 400, 2, 0, 0)
    expect(result).toEqual({ x: 100, y: 200 })
  })

  it('scales up by zoom (zoom=0.5 doubles canvas coordinates)', () => {
    const result = screenToCanvas(100, 50, 0.5, 0, 0)
    expect(result).toEqual({ x: 200, y: 100 })
  })

  it('subtracts pan before dividing by zoom', () => {
    // screen (150, 150), panX=50, panY=50, zoom=1 → canvas (100, 100)
    const result = screenToCanvas(150, 150, 1, 50, 50)
    expect(result).toEqual({ x: 100, y: 100 })
  })

  it('applies pan and zoom together correctly', () => {
    // screen (300, 200), panX=100, panY=0, zoom=2
    // canvas.x = (300 - 100) / 2 = 100
    // canvas.y = (200 - 0)   / 2 = 100
    const result = screenToCanvas(300, 200, 2, 100, 0)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(100)
  })

  it('handles negative pan offsets', () => {
    // screen (50, 50), panX=-100, panY=-100, zoom=1
    // canvas.x = (50 - (-100)) / 1 = 150
    const result = screenToCanvas(50, 50, 1, -100, -100)
    expect(result).toEqual({ x: 150, y: 150 })
  })

  it('handles fractional zoom values', () => {
    const result = screenToCanvas(100, 100, 0.25, 0, 0)
    expect(result.x).toBeCloseTo(400)
    expect(result.y).toBeCloseTo(400)
  })

  it('handles negative screen coordinates', () => {
    const result = screenToCanvas(-100, -50, 1, 0, 0)
    expect(result).toEqual({ x: -100, y: -50 })
  })

  it('x and y are independent of each other', () => {
    // Changing sx does not affect y; changing sy does not affect x
    const r1 = screenToCanvas(300, 100, 2, 0, 0)
    const r2 = screenToCanvas(300, 200, 2, 0, 0)
    expect(r1.x).toBe(r2.x)
    expect(r1.y).not.toBe(r2.y)
  })
})

// ---------------------------------------------------------------------------
// canvasToScreen
// ---------------------------------------------------------------------------

describe('canvasToScreen', () => {
  it('maps canvas origin to screen origin at zoom=1, pan=(0,0)', () => {
    const result = canvasToScreen(0, 0, 1, 0, 0)
    expect(result).toEqual({ x: 0, y: 0 })
  })

  it('is identity at zoom=1 with zero pan', () => {
    const result = canvasToScreen(100, 200, 1, 0, 0)
    expect(result).toEqual({ x: 100, y: 200 })
  })

  it('scales up by zoom (zoom=2 doubles screen coordinates)', () => {
    const result = canvasToScreen(100, 200, 2, 0, 0)
    expect(result).toEqual({ x: 200, y: 400 })
  })

  it('scales down by zoom (zoom=0.5 halves screen coordinates)', () => {
    const result = canvasToScreen(200, 100, 0.5, 0, 0)
    expect(result).toEqual({ x: 100, y: 50 })
  })

  it('adds pan after scaling', () => {
    // canvas (100, 100), panX=50, panY=50, zoom=1 → screen (150, 150)
    const result = canvasToScreen(100, 100, 1, 50, 50)
    expect(result).toEqual({ x: 150, y: 150 })
  })

  it('applies both scaling and pan correctly', () => {
    // canvas (100, 100), panX=100, panY=0, zoom=2
    // screen.x = 100 * 2 + 100 = 300
    // screen.y = 100 * 2 + 0   = 200
    const result = canvasToScreen(100, 100, 2, 100, 0)
    expect(result).toEqual({ x: 300, y: 200 })
  })

  it('handles negative pan offsets', () => {
    const result = canvasToScreen(150, 150, 1, -100, -100)
    expect(result).toEqual({ x: 50, y: 50 })
  })

  it('handles fractional zoom values', () => {
    const result = canvasToScreen(400, 400, 0.25, 0, 0)
    expect(result.x).toBeCloseTo(100)
    expect(result.y).toBeCloseTo(100)
  })
})

// ---------------------------------------------------------------------------
// Round-trip invariant: canvasToScreen(screenToCanvas(sx, sy)) === { sx, sy }
// ---------------------------------------------------------------------------

describe('round-trip invariant — screenToCanvas ↔ canvasToScreen', () => {
  const cases: Array<{
    label: string
    sx: number
    sy: number
    zoom: number
    panX: number
    panY: number
  }> = [
    { label: 'identity', sx: 0, sy: 0, zoom: 1, panX: 0, panY: 0 },
    { label: 'zoom=2', sx: 300, sy: 200, zoom: 2, panX: 0, panY: 0 },
    { label: 'zoom=0.5', sx: 100, sy: 50, zoom: 0.5, panX: 0, panY: 0 },
    { label: 'pan only', sx: 150, sy: 150, zoom: 1, panX: 50, panY: 50 },
    { label: 'pan + zoom', sx: 300, sy: 200, zoom: 2, panX: 100, panY: 0 },
    { label: 'negative pan', sx: 50, sy: 50, zoom: 1, panX: -100, panY: -100 },
    { label: 'zoom=1.5 + pan', sx: 200, sy: 300, zoom: 1.5, panX: 80, panY: -40 },
    { label: 'min zoom', sx: 100, sy: 100, zoom: MIN_ZOOM, panX: 0, panY: 0 },
    { label: 'max zoom', sx: 100, sy: 100, zoom: MAX_ZOOM, panX: 0, panY: 0 },
  ]

  for (const { label, sx, sy, zoom, panX, panY } of cases) {
    it(`round-trips losslessly (${label})`, () => {
      const canvas = screenToCanvas(sx, sy, zoom, panX, panY)
      const back = canvasToScreen(canvas.x, canvas.y, zoom, panX, panY)
      expect(back.x).toBeCloseTo(sx, 8)
      expect(back.y).toBeCloseTo(sy, 8)
    })
  }

  it('round-trip from canvas to screen and back', () => {
    const cx = 250
    const cy = 180
    const zoom = 1.25
    const panX = 60
    const panY = -30
    const screen = canvasToScreen(cx, cy, zoom, panX, panY)
    const back = screenToCanvas(screen.x, screen.y, zoom, panX, panY)
    expect(back.x).toBeCloseTo(cx, 8)
    expect(back.y).toBeCloseTo(cy, 8)
  })
})

// ---------------------------------------------------------------------------
// applyZoom
// ---------------------------------------------------------------------------

describe('applyZoom — zoom-to-cursor formula (Architecture Spec #435, Decision 3)', () => {
  it('returns the clamped target zoom', () => {
    const result = applyZoom(1, 2, 0, 0, 0, 0)
    expect(result.zoom).toBe(2)
  })

  it('clamps zoom to MIN_ZOOM when targetZoom is too low', () => {
    const result = applyZoom(1, -5, 0, 0, 0, 0)
    expect(result.zoom).toBe(MIN_ZOOM)
  })

  it('clamps zoom to MAX_ZOOM when targetZoom is too high', () => {
    const result = applyZoom(1, 999, 0, 0, 0, 0)
    expect(result.zoom).toBe(MAX_ZOOM)
  })

  it('with origin at (0,0) and zero pan, pan stays at (0,0) after zoom', () => {
    const result = applyZoom(1, 2, 0, 0, 0, 0)
    expect(result.panX).toBe(0)
    expect(result.panY).toBe(0)
  })

  it('computes cursor-centred pan adjustment (zoom toward point (100, 50))', () => {
    // Start at zoom=1, pan=(0,0), zoom toward origin (100, 50) → zoom=2
    const result = applyZoom(1, 2, 100, 50, 0, 0)
    expect(result.zoom).toBe(2)
    // newPanX = 100 - (2/1) * (100 - 0) = 100 - 200 = -100
    // newPanY = 50  - (2/1) * (50  - 0) = 50  - 100 = -50
    expect(result.panX).toBeCloseTo(-100)
    expect(result.panY).toBeCloseTo(-50)
  })

  it('origin point stays fixed in screen space after zoom', () => {
    // The key invariant: screenToCanvas(origin, pan, zoom) === screenToCanvas(origin, newPan, newZoom)
    const originX = 200
    const originY = 150
    const panX = 50
    const panY = -30
    const currentZoom = 1
    const newZoom = 1.5

    const before = screenToCanvas(originX, originY, currentZoom, panX, panY)
    const { zoom, panX: newPanX, panY: newPanY } = applyZoom(currentZoom, newZoom, originX, originY, panX, panY)
    const after = screenToCanvas(originX, originY, zoom, newPanX, newPanY)

    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('origin stays fixed when zooming out', () => {
    const originX = 150
    const originY = 100
    const panX = 0
    const panY = 0
    const currentZoom = 2
    const newZoom = 1

    const before = screenToCanvas(originX, originY, currentZoom, panX, panY)
    const { zoom, panX: newPanX, panY: newPanY } = applyZoom(currentZoom, newZoom, originX, originY, panX, panY)
    const after = screenToCanvas(originX, originY, zoom, newPanX, newPanY)

    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('origin stays fixed with non-zero initial pan', () => {
    const originX = 300
    const originY = 200
    const panX = -80
    const panY = 60
    const currentZoom = 1.5
    const newZoom = 2.5

    const before = screenToCanvas(originX, originY, currentZoom, panX, panY)
    const { zoom, panX: newPanX, panY: newPanY } = applyZoom(currentZoom, newZoom, originX, originY, panX, panY)
    const after = screenToCanvas(originX, originY, zoom, newPanX, newPanY)

    expect(after.x).toBeCloseTo(before.x, 5)
    expect(after.y).toBeCloseTo(before.y, 5)
  })

  it('returns current values unchanged when currentZoom === newZoom', () => {
    const panX = 100
    const panY = -50
    const zoom = 1.5
    const result = applyZoom(zoom, zoom, 200, 100, panX, panY)
    expect(result.zoom).toBe(zoom)
    expect(result.panX).toBeCloseTo(panX)
    expect(result.panY).toBeCloseTo(panY)
  })

  it('returns an object with zoom, panX, panY', () => {
    const result = applyZoom(1, 2, 0, 0, 0, 0)
    expect(typeof result.zoom).toBe('number')
    expect(typeof result.panX).toBe('number')
    expect(typeof result.panY).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// applyPan
// ---------------------------------------------------------------------------

describe('applyPan', () => {
  it('adds delta to the current pan offset', () => {
    const result = applyPan(100, -50, 30, -20)
    expect(result).toEqual({ panX: 130, panY: -70 })
  })

  it('handles zero deltas (no movement)', () => {
    const result = applyPan(200, 300, 0, 0)
    expect(result).toEqual({ panX: 200, panY: 300 })
  })

  it('handles zero starting pan', () => {
    const result = applyPan(0, 0, 50, -30)
    expect(result).toEqual({ panX: 50, panY: -30 })
  })

  it('handles negative deltas (pan in reverse)', () => {
    const result = applyPan(100, 100, -150, -200)
    expect(result).toEqual({ panX: -50, panY: -100 })
  })

  it('handles large deltas', () => {
    const result = applyPan(0, 0, 50000, -50000)
    expect(result).toEqual({ panX: 50000, panY: -50000 })
  })

  it('is commutative in dx/dy — applying two deltas in sequence equals applying their sum', () => {
    const start = { panX: 0, panY: 0 }
    const step1 = applyPan(start.panX, start.panY, 50, 30)
    const step2 = applyPan(step1.panX, step1.panY, 70, -20)
    const combined = applyPan(start.panX, start.panY, 120, 10)
    expect(step2).toEqual(combined)
  })

  it('x and y pan are independent', () => {
    const r1 = applyPan(100, 200, 10, 0)
    const r2 = applyPan(100, 200, 0, 10)
    expect(r1.panX).toBe(110)
    expect(r1.panY).toBe(200)
    expect(r2.panX).toBe(100)
    expect(r2.panY).toBe(210)
  })
})

// ---------------------------------------------------------------------------
// zoomFromWheelDelta
// ---------------------------------------------------------------------------

describe('zoomFromWheelDelta', () => {
  it('returns a number', () => {
    expect(typeof zoomFromWheelDelta(1, 100)).toBe('number')
  })

  it('deltaY > 0 (scroll down) decreases zoom', () => {
    // Scrolling down = zoom out
    const newZoom = zoomFromWheelDelta(1, 100)
    expect(newZoom).toBeLessThan(1)
  })

  it('deltaY < 0 (scroll up) increases zoom', () => {
    // Scrolling up = zoom in
    const newZoom = zoomFromWheelDelta(1, -100)
    expect(newZoom).toBeGreaterThan(1)
  })

  it('deltaY = 0 returns current zoom unchanged', () => {
    const newZoom = zoomFromWheelDelta(1.5, 0)
    expect(newZoom).toBeCloseTo(1.5)
  })

  it('result is always clamped to [MIN_ZOOM, MAX_ZOOM]', () => {
    // Massive scroll down at min zoom
    expect(zoomFromWheelDelta(MIN_ZOOM, 100000)).toBe(MIN_ZOOM)
    // Massive scroll up at max zoom
    expect(zoomFromWheelDelta(MAX_ZOOM, -100000)).toBe(MAX_ZOOM)
  })

  it('result is always a positive finite number', () => {
    for (const delta of [-1000, -100, -10, 0, 10, 100, 1000]) {
      const result = zoomFromWheelDelta(1, delta)
      expect(result).toBeGreaterThan(0)
      expect(Number.isFinite(result)).toBe(true)
    }
  })

  it('larger deltaY magnitude produces a bigger zoom change', () => {
    const smallChange = Math.abs(zoomFromWheelDelta(1, 10) - 1)
    const largeChange = Math.abs(zoomFromWheelDelta(1, 100) - 1)
    expect(largeChange).toBeGreaterThan(smallChange)
  })

  it('wheel-notch sized deltas stay in the 13–16% zoom change range', () => {
    const zoomOutChange = Math.abs(zoomFromWheelDelta(1, 100) - 1)
    const zoomInChange = Math.abs(zoomFromWheelDelta(1, -100) - 1)

    expect(zoomOutChange).toBeGreaterThan(0.13)
    expect(zoomOutChange).toBeLessThan(0.16)
    expect(zoomInChange).toBeGreaterThan(0.13)
    expect(zoomInChange).toBeLessThan(0.17)
  })

  it('zoom direction is consistent across starting zoom levels', () => {
    // Scrolling down always decreases zoom regardless of starting level
    expect(zoomFromWheelDelta(0.5, 50)).toBeLessThan(0.5)
    expect(zoomFromWheelDelta(1.5, 50)).toBeLessThan(1.5)
    expect(zoomFromWheelDelta(3.0, 50)).toBeLessThan(3.0)
  })

  it('is a pure function — same inputs produce same output', () => {
    expect(zoomFromWheelDelta(1, 100)).toBe(zoomFromWheelDelta(1, 100))
    expect(zoomFromWheelDelta(2, -50)).toBe(zoomFromWheelDelta(2, -50))
  })

  it('trackpad-style small deltas produce proportionally small zoom changes', () => {
    // Trackpad sends small deltas (1–3 per event at 60fps)
    // Zoom change should be small — user should not see jarring jumps
    const smallDelta = zoomFromWheelDelta(1, 3)
    expect(Math.abs(smallDelta - 1)).toBeLessThan(0.01)
  })

  it('medium trackpad deltas stay in the 1.4–1.7% zoom change range', () => {
    const zoomOutChange = Math.abs(zoomFromWheelDelta(1, 10) - 1)
    const zoomInChange = Math.abs(zoomFromWheelDelta(1, -10) - 1)

    expect(zoomOutChange).toBeGreaterThan(0.014)
    expect(zoomOutChange).toBeLessThan(0.017)
    expect(zoomInChange).toBeGreaterThan(0.014)
    expect(zoomInChange).toBeLessThan(0.017)
  })
})

// ---------------------------------------------------------------------------
// incrementalScaleFromPinchMovement
// ---------------------------------------------------------------------------

describe('incrementalScaleFromPinchMovement', () => {
  function getHelper() {
    const { incrementalScaleFromPinchMovement } = canvasMath as typeof canvasMath & {
      incrementalScaleFromPinchMovement?: (currentMovement: number, previousMovement: number) => number
    }
    expect(typeof incrementalScaleFromPinchMovement).toBe('function')
    return incrementalScaleFromPinchMovement!
  }

  it('converts accumulated pinch scale movement into an incremental multiplier', () => {
    const incrementalScaleFromPinchMovement = getHelper()

    // @use-gesture pinch movement[0] is the scale accumulated since gesture
    // start. Consecutive movement values 1.05 -> 1.10 should apply only the
    // ratio between them, not another full 1.10x zoom step.
    expect(incrementalScaleFromPinchMovement(1.10, 1.05)).toBeCloseTo(1.10 / 1.05, 6)
  })

  it('treats the first pinch frame as a neutral multiplier', () => {
    const incrementalScaleFromPinchMovement = getHelper()

    expect(incrementalScaleFromPinchMovement(1, 1)).toBe(1)
  })

  it('ignores invalid movement values instead of creating zoom jumps', () => {
    const incrementalScaleFromPinchMovement = getHelper()

    expect(incrementalScaleFromPinchMovement(1.2, 0)).toBe(1)
    expect(incrementalScaleFromPinchMovement(Number.NaN, 1)).toBe(1)
    expect(incrementalScaleFromPinchMovement(Number.POSITIVE_INFINITY, 1)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Cross-function: applyZoom uses screenToCanvas internally (invariant check)
// ---------------------------------------------------------------------------

describe('applyZoom invariant — origin stays fixed in canvas space', () => {
  it('zooming from any starting zoom preserves the canvas position under the cursor', () => {
    const cases = [
      { currentZoom: 1, newZoom: 2, ox: 200, oy: 150, px: 0, py: 0 },
      { currentZoom: 2, newZoom: 1, ox: 300, oy: 200, px: -100, py: 50 },
      { currentZoom: 1.5, newZoom: 3, ox: 100, oy: 80, px: 40, py: -30 },
      { currentZoom: 3, newZoom: 0.5, ox: 400, oy: 300, px: 200, py: 100 },
    ]

    for (const { currentZoom, newZoom, ox, oy, px, py } of cases) {
      const canvasBefore = screenToCanvas(ox, oy, currentZoom, px, py)
      const { zoom, panX, panY } = applyZoom(currentZoom, newZoom, ox, oy, px, py)
      const canvasAfter = screenToCanvas(ox, oy, zoom, panX, panY)
      expect(canvasAfter.x).toBeCloseTo(canvasBefore.x, 5)
      expect(canvasAfter.y).toBeCloseTo(canvasBefore.y, 5)
    }
  })
})
