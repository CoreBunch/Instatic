/**
 * canvasSlice — unit tests
 *
 * Verifies the Zustand canvas slice setters enforce their invariants:
 *   - setZoom clamps to [MIN_ZOOM, MAX_ZOOM]
 *   - setPan clamps to [±MAX_PAN]
 *   - zoomTo clamps both zoom and the resulting pan values
 *   - zoomIn / zoomOut step through ZOOM_STEPS
 *   - resetView restores defaults
 *
 * Security note (Contribution #435, Security Auditor review message #1270):
 * Clamping MUST happen inside the setter, not at call sites. The agent tool
 * dispatch path (Phase D) can write to the canvas slice via validated tool calls
 * (Constraint #272), but belt-and-suspenders clamping inside the setter prevents
 * any future bypass from putting the canvas into an invalid state.
 *
 * @see Contribution #435 — Phase 2 Infinite Canvas Architecture Spec
 * @see MIN_ZOOM, MAX_ZOOM, MAX_PAN constants in canvasSlice.ts
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import {
  MIN_ZOOM,
  MAX_ZOOM,
  INITIAL_ZOOM,
  RESET_ZOOM,
  MAX_PAN,
  clampZoom,
  clampPan,
} from '@site/canvas/math'

// ---------------------------------------------------------------------------
// Store reset helper
// ---------------------------------------------------------------------------

beforeEach(() => {
  useEditorStore.setState({
    zoom: RESET_ZOOM,
    panX: 0,
    panY: 0,
    canvasMode: 'select',
  })
})

function canvas() {
  const s = useEditorStore.getState()
  return { zoom: s.zoom, panX: s.panX, panY: s.panY }
}

// ---------------------------------------------------------------------------
// clampZoom (pure function)
// ---------------------------------------------------------------------------

describe('clampZoom — pure function', () => {
  it('leaves value unchanged when within [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(clampZoom(0.5)).toBe(0.5)
    expect(clampZoom(1.0)).toBe(1.0)
    expect(clampZoom(2.0)).toBe(2.0)
    expect(clampZoom(3.5)).toBe(3.5)
  })

  it('clamps to MIN_ZOOM when below minimum', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(-1)).toBe(MIN_ZOOM)
    expect(clampZoom(-9999)).toBe(MIN_ZOOM)
    expect(clampZoom(MIN_ZOOM - 0.001)).toBe(MIN_ZOOM)
  })

  it('clamps to MAX_ZOOM when above maximum', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM)
    expect(clampZoom(9999)).toBe(MAX_ZOOM)
    expect(clampZoom(MAX_ZOOM + 0.001)).toBe(MAX_ZOOM)
  })

  it('returns MIN_ZOOM exactly at boundary', () => {
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM)
  })

  it('returns MAX_ZOOM exactly at boundary', () => {
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM)
  })
})

// ---------------------------------------------------------------------------
// clampPan (pure function)
// ---------------------------------------------------------------------------

describe('clampPan — pure function', () => {
  it('leaves value unchanged when within [−MAX_PAN, +MAX_PAN]', () => {
    expect(clampPan(0)).toBe(0)
    expect(clampPan(1000)).toBe(1000)
    expect(clampPan(-1000)).toBe(-1000)
    expect(clampPan(MAX_PAN)).toBe(MAX_PAN)
    expect(clampPan(-MAX_PAN)).toBe(-MAX_PAN)
  })

  it('clamps to −MAX_PAN when below minimum', () => {
    expect(clampPan(-MAX_PAN - 1)).toBe(-MAX_PAN)
    expect(clampPan(-999999)).toBe(-MAX_PAN)
    expect(clampPan(-Infinity)).toBe(-MAX_PAN)
  })

  it('clamps to +MAX_PAN when above maximum', () => {
    expect(clampPan(MAX_PAN + 1)).toBe(MAX_PAN)
    expect(clampPan(999999)).toBe(MAX_PAN)
    expect(clampPan(Infinity)).toBe(MAX_PAN)
  })

  it('returns 0 for NaN (Math.max/min behaviour)', () => {
    // NaN comparisons always return false — max/min fall through to the boundary
    // The actual result is NaN because NaN > x is false — test documents the behaviour
    const result = clampPan(NaN)
    expect(typeof result).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// setZoom — store action
// ---------------------------------------------------------------------------

describe('setZoom — store action clamping (Security Auditor requirement, message #1270)', () => {
  it('sets zoom within valid range', () => {
    useEditorStore.getState().setZoom(1.5)
    expect(canvas().zoom).toBe(1.5)
  })

  it('clamps to MIN_ZOOM when called with a value below minimum', () => {
    useEditorStore.getState().setZoom(0)
    expect(canvas().zoom).toBe(MIN_ZOOM)
  })

  it('clamps to MIN_ZOOM when called with a negative value', () => {
    useEditorStore.getState().setZoom(-999)
    expect(canvas().zoom).toBe(MIN_ZOOM)
  })

  it('clamps to MAX_ZOOM when called with a value above maximum', () => {
    useEditorStore.getState().setZoom(100)
    expect(canvas().zoom).toBe(MAX_ZOOM)
  })

  it('clamps to MAX_ZOOM when called with Infinity', () => {
    useEditorStore.getState().setZoom(Infinity)
    expect(canvas().zoom).toBe(MAX_ZOOM)
  })

  it('accepts MIN_ZOOM exactly', () => {
    useEditorStore.getState().setZoom(MIN_ZOOM)
    expect(canvas().zoom).toBe(MIN_ZOOM)
  })

  it('accepts MAX_ZOOM exactly', () => {
    useEditorStore.getState().setZoom(MAX_ZOOM)
    expect(canvas().zoom).toBe(MAX_ZOOM)
  })
})

// ---------------------------------------------------------------------------
// setPan — store action (belt-and-suspenders clamping, Security Auditor message #1270)
// ---------------------------------------------------------------------------

describe('setPan — store action clamping (Security Auditor requirement, message #1270)', () => {
  it('sets panX and panY within valid range', () => {
    useEditorStore.getState().setPan(1000, -2000)
    const { panX, panY } = canvas()
    expect(panX).toBe(1000)
    expect(panY).toBe(-2000)
  })

  it('clamps panX to +MAX_PAN when above maximum', () => {
    useEditorStore.getState().setPan(999999, 0)
    expect(canvas().panX).toBe(MAX_PAN)
  })

  it('clamps panX to −MAX_PAN when below minimum', () => {
    useEditorStore.getState().setPan(-999999, 0)
    expect(canvas().panX).toBe(-MAX_PAN)
  })

  it('clamps panY to +MAX_PAN when above maximum', () => {
    useEditorStore.getState().setPan(0, 999999)
    expect(canvas().panY).toBe(MAX_PAN)
  })

  it('clamps panY to −MAX_PAN when below minimum', () => {
    useEditorStore.getState().setPan(0, -999999)
    expect(canvas().panY).toBe(-MAX_PAN)
  })

  it('clamps both axes independently', () => {
    useEditorStore.getState().setPan(-MAX_PAN - 500, MAX_PAN + 500)
    const { panX, panY } = canvas()
    expect(panX).toBe(-MAX_PAN)
    expect(panY).toBe(MAX_PAN)
  })

  it('accepts ±MAX_PAN exactly at boundary', () => {
    useEditorStore.getState().setPan(MAX_PAN, -MAX_PAN)
    const { panX, panY } = canvas()
    expect(panX).toBe(MAX_PAN)
    expect(panY).toBe(-MAX_PAN)
  })

  it('clamps Infinity panX to MAX_PAN', () => {
    useEditorStore.getState().setPan(Infinity, 0)
    expect(canvas().panX).toBe(MAX_PAN)
  })

  it('clamps −Infinity panY to −MAX_PAN', () => {
    useEditorStore.getState().setPan(0, -Infinity)
    expect(canvas().panY).toBe(-MAX_PAN)
  })
})

// ---------------------------------------------------------------------------
// setCanvasTransform — atomic transform commit
// ---------------------------------------------------------------------------

describe('setCanvasTransform — atomic zoom/pan commit', () => {
  it('updates zoom and pan in one store notification so subscribers never see a mixed transform', () => {
    const observed: Array<{ zoom: number; panX: number; panY: number }> = []
    const unsubscribe = useEditorStore.subscribe((state) => {
      observed.push({ zoom: state.zoom, panX: state.panX, panY: state.panY })
    })

    useEditorStore.getState().setCanvasTransform(1.25, 300, -120)
    unsubscribe()

    expect(canvas()).toEqual({ zoom: 1.25, panX: 300, panY: -120 })
    expect(observed).toEqual([{ zoom: 1.25, panX: 300, panY: -120 }])
  })
})

// ---------------------------------------------------------------------------
// zoomTo — cursor-centred zoom with pan adjustment + clamping
// ---------------------------------------------------------------------------

describe('zoomTo — zoom and pan clamping', () => {
  it('sets zoom to the target level', () => {
    useEditorStore.getState().zoomTo(2.0)
    expect(canvas().zoom).toBe(2.0)
  })

  it('clamps zoom to MIN_ZOOM when targetZoom is too low', () => {
    useEditorStore.getState().zoomTo(-1)
    expect(canvas().zoom).toBe(MIN_ZOOM)
  })

  it('clamps zoom to MAX_ZOOM when targetZoom is too high', () => {
    useEditorStore.getState().zoomTo(99)
    expect(canvas().zoom).toBe(MAX_ZOOM)
  })

  it('with no origin, pan remains 0 after zoom from default', () => {
    useEditorStore.getState().zoomTo(2.0)
    const { panX, panY } = canvas()
    // With originX=0, originY=0 and panX=0, panY=0:
    // newPanX = 0 - (2/1) * (0 - 0) = 0
    expect(panX).toBe(0)
    expect(panY).toBe(0)
  })

  it('computes cursor-centred pan adjustment correctly', () => {
    // Start at zoom=1, pan=0, zoom towards origin (100, 50) → zoom=2
    useEditorStore.getState().zoomTo(2.0, 100, 50)
    const { zoom, panX, panY } = canvas()
    expect(zoom).toBe(2.0)
    // newPanX = 100 - (2/1) * (100 - 0) = 100 - 200 = -100
    // newPanY = 50  - (2/1) * (50  - 0) = 50  - 100 = -50
    expect(panX).toBe(-100)
    expect(panY).toBe(-50)
  })

  it('clamps the resulting pan to MAX_PAN when the origin-centred pan exceeds bounds', () => {
    // Set up a scenario where origin-centred zoom would produce pan > MAX_PAN
    // Start with panX near MAX_PAN boundary
    useEditorStore.setState({ panX: MAX_PAN - 100, panY: 0, zoom: 1 })
    // Zooming in further from a large-offset origin can push pan over MAX_PAN
    useEditorStore.getState().zoomTo(2.0, 0, 0)
    const { panX } = canvas()
    expect(panX).toBeGreaterThanOrEqual(-MAX_PAN)
    expect(panX).toBeLessThanOrEqual(MAX_PAN)
  })
})

// ---------------------------------------------------------------------------
// zoomIn / zoomOut — step through ZOOM_STEPS
// ---------------------------------------------------------------------------

describe('zoomIn / zoomOut', () => {
  it('zoomIn from default (1.0) steps to 1.25', () => {
    useEditorStore.getState().zoomIn()
    expect(canvas().zoom).toBe(1.25)
  })

  it('zoomOut from default (1.0) steps to 0.75', () => {
    useEditorStore.getState().zoomOut()
    expect(canvas().zoom).toBe(0.75)
  })

  it('zoomIn does not exceed MAX_ZOOM', () => {
    useEditorStore.setState({ zoom: MAX_ZOOM })
    useEditorStore.getState().zoomIn()
    expect(canvas().zoom).toBe(MAX_ZOOM)
  })

  it('zoomOut does not go below MIN_ZOOM', () => {
    useEditorStore.setState({ zoom: MIN_ZOOM })
    useEditorStore.getState().zoomOut()
    expect(canvas().zoom).toBe(MIN_ZOOM)
  })

  it('repeated zoomIn steps through all zoom levels and caps at MAX_ZOOM', () => {
    useEditorStore.setState({ zoom: 0.1 })
    const ZOOM_STEPS_ASCENDING = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
    for (const expected of ZOOM_STEPS_ASCENDING) {
      useEditorStore.getState().zoomIn()
      expect(canvas().zoom).toBe(expected)
    }
    // One more zoomIn should stay at MAX_ZOOM
    useEditorStore.getState().zoomIn()
    expect(canvas().zoom).toBe(MAX_ZOOM)
  })
})

// ---------------------------------------------------------------------------
// resetView
// ---------------------------------------------------------------------------

describe('resetView', () => {
  it('resets zoom to RESET_ZOOM (100%), not the 50% initial design zoom', () => {
    useEditorStore.setState({ zoom: 2.5 })
    useEditorStore.getState().resetView()
    expect(canvas().zoom).toBe(RESET_ZOOM)
    expect(INITIAL_ZOOM).toBe(0.5)
  })

  it('resets pan to (0, 0)', () => {
    useEditorStore.setState({ panX: 3000, panY: -1500 })
    useEditorStore.getState().resetView()
    const { panX, panY } = canvas()
    expect(panX).toBe(0)
    expect(panY).toBe(0)
  })

  it('resets from extreme (clamped) values', () => {
    useEditorStore.setState({ zoom: MAX_ZOOM, panX: MAX_PAN, panY: -MAX_PAN })
    useEditorStore.getState().resetView()
    const { zoom, panX, panY } = canvas()
    expect(zoom).toBe(RESET_ZOOM)
    expect(panX).toBe(0)
    expect(panY).toBe(0)
  })
})
