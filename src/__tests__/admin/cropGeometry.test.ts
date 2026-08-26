/**
 * Crop geometry — the arithmetic the crop dialog rides on.
 *
 * Every case here is a bug that would otherwise only show up as a wrong-looking
 * image after a publish: a rectangle escaping the frame, a square preset that
 * isn't square on a non-square photo, an edge handle that drags two edges, or a
 * preview divide-by-zero on a full-width crop.
 */
import { describe, expect, it } from 'bun:test'
import {
  FULL_FRAME,
  applyRatio,
  clampFocusArea,
  clampRect,
  defaultFocusArea,
  focusAreaWithinCrop,
  isFullFrame,
  moveFocusArea,
  moveRect,
  previewStyle,
  resizeFocusArea,
  resizeRect,
} from '@admin/pages/media/components/CropDialog/cropGeometry'

/** Focal point that leaves a preview unshifted, for cases not about focus. */
const CENTRE = { x: 0.5, y: 0.5 }

describe('clampRect', () => {
  it('keeps a rectangle inside the frame', () => {
    const r = clampRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })
    expect(r.x + r.width).toBeLessThanOrEqual(1.0001)
    expect(r.y + r.height).toBeLessThanOrEqual(1.0001)
  })

  it('refuses to collapse below the minimum extent', () => {
    const r = clampRect({ x: 0.5, y: 0.5, width: 0, height: -1 })
    expect(r.width).toBeGreaterThan(0)
    expect(r.height).toBeGreaterThan(0)
  })
})

describe('moveRect', () => {
  it('stops at the frame edge instead of sliding out', () => {
    const r = moveRect({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 0.4, 0.4)
    expect(r.x).toBeCloseTo(0.5)
    expect(r.y).toBeCloseTo(0.5)
  })
})

describe('resizeRect', () => {
  it('inverts through the anchor rather than going negative', () => {
    // Drag the NW corner past the SE corner: width/height must stay positive.
    const r = resizeRect({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, 'nw', 0.9, 0.9)
    expect(r.width).toBeGreaterThan(0)
    expect(r.height).toBeGreaterThan(0)
    expect(r.x).toBeCloseTo(0.5)
  })

  it('clamps a pointer dragged outside the image', () => {
    const r = resizeRect({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, 'se', 5, 5)
    expect(r.x + r.width).toBeLessThanOrEqual(1.0001)
  })

  // The reason the edge handles exist: pulling the top edge down must leave the
  // left and right edges exactly where they were. A corner-only implementation
  // silently drags the horizontal axis along, which is what "I can only resize
  // diagonally" looks like from the outside.
  it('moves only the vertical axis for a north handle', () => {
    const start = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
    const r = resizeRect(start, 'n', 0.9, 0.4)
    expect(r.x).toBeCloseTo(start.x, 5)
    expect(r.width).toBeCloseTo(start.width, 5)
    expect(r.y).toBeCloseTo(0.4, 5)
    expect(r.y + r.height).toBeCloseTo(0.8, 5)
  })

  it('moves only the horizontal axis for a west handle', () => {
    const start = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
    const r = resizeRect(start, 'w', 0.4, 0.9)
    expect(r.y).toBeCloseTo(start.y, 5)
    expect(r.height).toBeCloseTo(start.height, 5)
    expect(r.x).toBeCloseTo(0.4, 5)
    expect(r.x + r.width).toBeCloseTo(0.8, 5)
  })

  it('moves both axes for a corner handle', () => {
    const start = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
    const r = resizeRect(start, 'se', 0.5, 0.5)
    expect(r.width).toBeCloseTo(0.3, 5)
    expect(r.height).toBeCloseTo(0.3, 5)
  })
})

describe('applyRatio', () => {
  it('produces a visually square crop on a non-square image', () => {
    // 3000x2000 photo → aspect 1.5. A 1:1 crop must be 1.5x taller in
    // fraction space than it is wide.
    const r = applyRatio({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, 1, 1.5)
    const renderedAspect = (r.width / r.height) * 1.5
    expect(renderedAspect).toBeCloseTo(1, 3)
  })

  it('keeps 16:9 inside the frame', () => {
    const r = applyRatio(FULL_FRAME, 16 / 9, 1.5)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(1.0001)
    expect(r.y + r.height).toBeLessThanOrEqual(1.0001)
    expect((r.width / r.height) * 1.5).toBeCloseTo(16 / 9, 3)
  })

  it('does not shrink toward zero when applied repeatedly', () => {
    let r = applyRatio(FULL_FRAME, 1, 1.5)
    const first = r.width
    for (let i = 0; i < 5; i += 1) r = applyRatio(r, 1, 1.5)
    expect(r.width).toBeCloseTo(first, 3)
  })
})

describe('isFullFrame', () => {
  it('recognises the uncropped rectangle', () => {
    expect(isFullFrame(FULL_FRAME)).toBe(true)
    expect(isFullFrame({ x: 0, y: 0, width: 0.9, height: 1 })).toBe(false)
  })
})

describe('previewStyle', () => {
  it('emits finite values for a full-width crop', () => {
    const style = previewStyle({ x: 0, y: 0, width: 1, height: 0.5 }, 1.5, 1, CENTRE)
    expect(style.position).toBe('0% 0%')
    expect(style.size).toContain('100%')
  })

  // Cover, not contain: a 3:1 crop in a square box must overflow horizontally
  // and be cut, exactly as the published slot would cut it. A contained preview
  // would letterbox instead and hide the decision being made.
  it('overflows the longer axis so the box is filled, never letterboxed', () => {
    const style = previewStyle({ x: 0, y: 0.25, width: 1, height: 0.5 }, 1.5, 1, CENTRE)
    expect(style.innerHeight).toBe('100%')
    expect(parseFloat(style.innerWidth)).toBeGreaterThan(100)
  })

  it('fills the box exactly when crop and box share an aspect', () => {
    // 1:1 crop of a 1.5-aspect image is 0.667 wide x 1.0 tall in fractions.
    const style = previewStyle({ x: 0, y: 0, width: 2 / 3, height: 1 }, 1.5, 1, CENTRE)
    expect(style.innerWidth).toBe('100%')
    expect(style.innerHeight).toBe('100%')
    expect(parseFloat(style.offsetX)).toBeCloseTo(0, 5)
    expect(parseFloat(style.offsetY)).toBeCloseTo(0, 5)
  })

  it('pins the left edge when the focus sits at the left of an overflowing crop', () => {
    const style = previewStyle({ x: 0, y: 0, width: 1, height: 0.5 }, 1.5, 1, { x: 0, y: 0.5 })
    expect(parseFloat(style.offsetX)).toBeCloseTo(0, 5)
  })

  it('slides the whole overflow away when the focus sits at the right', () => {
    const crop = { x: 0, y: 0, width: 1, height: 0.5 }
    const style = previewStyle(crop, 1.5, 1, { x: 1, y: 0.5 })
    // Overflow is (innerWidth - 100); pinning the right edge consumes all of it.
    expect(parseFloat(style.offsetX)).toBeCloseTo(100 - parseFloat(style.innerWidth), 5)
  })

  it('centres the overflow for a centred focus', () => {
    const style = previewStyle({ x: 0, y: 0, width: 1, height: 0.5 }, 1.5, 1, CENTRE)
    expect(parseFloat(style.offsetX)).toBeCloseTo((100 - parseFloat(style.innerWidth)) / 2, 5)
  })
})

describe('focus area', () => {
  it('defaults to a circle centred on the crop', () => {
    const rect = { x: 0.2, y: 0.4, width: 0.4, height: 0.2 }
    const imageAspect = 1
    const area = defaultFocusArea(rect, imageAspect)
    expect(area.x).toBeCloseTo(0.4, 5)
    expect(area.y).toBeCloseTo(0.5, 5)
    // Roundness is measured against the IMAGE, not the crop: the fractions are
    // fractions of the image, so the axes are equal in pixels exactly when
    // `width * imageWidth == height * imageHeight`. A 2:1 crop must therefore
    // still yield a circle, not an ellipse stretched to match the crop.
    expect((area.width / area.height) * imageAspect).toBeCloseTo(1, 5)
  })

  it('draws a rendered circle on a non-square image too', () => {
    const rect = { x: 0, y: 0, width: 1, height: 1 }
    const imageAspect = 1.5
    const area = defaultFocusArea(rect, imageAspect)
    expect((area.width / area.height) * imageAspect).toBeCloseTo(1, 5)
  })

  it('fits inside the crop it belongs to', () => {
    const rect = { x: 0.2, y: 0.4, width: 0.4, height: 0.2 }
    const area = defaultFocusArea(rect, 1)
    expect(area.x - area.width / 2).toBeGreaterThanOrEqual(rect.x - 1e-9)
    expect(area.x + area.width / 2).toBeLessThanOrEqual(rect.x + rect.width + 1e-9)
    expect(area.y - area.height / 2).toBeGreaterThanOrEqual(rect.y - 1e-9)
    expect(area.y + area.height / 2).toBeLessThanOrEqual(rect.y + rect.height + 1e-9)
  })

  it('pushes an out-of-bounds ellipse fully back inside the crop', () => {
    const rect = { x: 0.5, y: 0, width: 0.5, height: 0.5 }
    const area = clampFocusArea({ x: 0.1, y: 0.9, width: 0.2, height: 0.2 }, rect)
    expect(area.x - area.width / 2).toBeGreaterThanOrEqual(rect.x - 1e-9)
    expect(area.y + area.height / 2).toBeLessThanOrEqual(rect.y + rect.height + 1e-9)
  })

  // Shrink-then-place, not place-then-shrink: an ellipse larger than the crop
  // has no legal centre, so clamping the centre first would leave it hanging
  // over an edge no matter what the extent was afterwards.
  it('shrinks an oversized ellipse to the crop rather than overflowing', () => {
    const rect = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    const area = clampFocusArea({ x: 0.5, y: 0.5, width: 5, height: 5 }, rect)
    expect(area.width).toBeLessThanOrEqual(rect.width + 1e-9)
    expect(area.height).toBeLessThanOrEqual(rect.height + 1e-9)
    expect(area.x - area.width / 2).toBeGreaterThanOrEqual(rect.x - 1e-9)
  })

  it('never collapses to nothing', () => {
    const rect = FULL_FRAME
    const area = clampFocusArea({ x: 0.5, y: 0.5, width: 0, height: -1 }, rect)
    expect(area.width).toBeGreaterThan(0)
    expect(area.height).toBeGreaterThan(0)
  })

  it('moves by a delta from where the drag started', () => {
    const rect = FULL_FRAME
    const origin = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }
    const moved = moveFocusArea(origin, 0.1, -0.2, rect)
    expect(moved.x).toBeCloseTo(0.6, 5)
    expect(moved.y).toBeCloseTo(0.3, 5)
    expect(moved.width).toBeCloseTo(origin.width, 5)
  })

  // A zero-delta drag must be a no-op. Reading the extent straight off the
  // pointer instead would shrink the ellipse by √2 the instant its rim handle
  // was grabbed, because that handle sits at 45°, not on a semi-axis.
  it('does not jump when the resize handle is grabbed and not moved', () => {
    const rect = FULL_FRAME
    const origin = { x: 0.5, y: 0.5, width: 0.3, height: 0.3 }
    const resized = resizeFocusArea(origin, 0, 0, rect)
    expect(resized.width).toBeCloseTo(origin.width, 5)
    expect(resized.height).toBeCloseTo(origin.height, 5)
  })

  it('grows symmetrically about a fixed centre', () => {
    const rect = FULL_FRAME
    const origin = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }
    const resized = resizeFocusArea(origin, 0.05, 0.05, rect)
    expect(resized.width).toBeCloseTo(0.3, 5)
    expect(resized.height).toBeCloseTo(0.3, 5)
    expect(resized.x).toBeCloseTo(origin.x, 5)
    expect(resized.y).toBeCloseTo(origin.y, 5)
  })

  it('resizes each axis independently, so a wide subject is expressible', () => {
    const rect = FULL_FRAME
    const origin = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }
    const resized = resizeFocusArea(origin, 0.1, 0, rect)
    expect(resized.width).toBeCloseTo(0.4, 5)
    expect(resized.height).toBeCloseTo(0.2, 5)
  })

  it('expresses the area in crop-relative fractions for the previews', () => {
    const rect = { x: 0.5, y: 0, width: 0.5, height: 1 }
    const within = focusAreaWithinCrop({ x: 0.75, y: 0.25, width: 0.25, height: 0.5 }, rect)
    expect(within.x).toBeCloseTo(0.5, 5)
    expect(within.y).toBeCloseTo(0.25, 5)
    expect(within.width).toBeCloseTo(0.5, 5)
    expect(within.height).toBeCloseTo(0.5, 5)
  })

  it('never returns a marker position outside the box', () => {
    const rect = { x: 0.5, y: 0.5, width: 0.25, height: 0.25 }
    const at = focusAreaWithinCrop({ x: 0, y: 1, width: 0.1, height: 0.1 }, rect)
    expect(at.x).toBeGreaterThanOrEqual(0)
    expect(at.y).toBeLessThanOrEqual(1)
  })
})
