/**
 * spacingBandRect — pure geometry for the live spacing highlight
 * (SpacingHighlightOverlay). Margin bands attach OUTSIDE the border box,
 * padding bands INSIDE it (inset by the border widths). All coordinates are
 * iframe-document px; the measure session translates them to overlay space.
 */
import { describe, it, expect } from 'bun:test'
import { spacingBandRect, type SpacingBandBox } from '@site/canvas/spacingHighlightGeometry'

const borderBox: SpacingBandBox = { left: 100, top: 50, width: 200, height: 80 }
const noBorders = { top: 0, right: 0, bottom: 0, left: 0 }
const borders = { top: 2, right: 4, bottom: 6, left: 8 }

describe('spacingBandRect — margin (outside the border box)', () => {
  it('top band sits above, spanning the border-box width', () => {
    expect(spacingBandRect('margin', 'top', borderBox, 10, noBorders)).toEqual({
      left: 100,
      top: 40,
      width: 200,
      height: 10,
    })
  })

  it('bottom band sits below', () => {
    expect(spacingBandRect('margin', 'bottom', borderBox, 10, noBorders)).toEqual({
      left: 100,
      top: 130,
      width: 200,
      height: 10,
    })
  })

  it('left / right bands flank the box, spanning its height', () => {
    expect(spacingBandRect('margin', 'left', borderBox, 12, noBorders)).toEqual({
      left: 88,
      top: 50,
      width: 12,
      height: 80,
    })
    expect(spacingBandRect('margin', 'right', borderBox, 12, noBorders)).toEqual({
      left: 300,
      top: 50,
      width: 12,
      height: 80,
    })
  })
})

describe('spacingBandRect — padding (inside the border box, inset by borders)', () => {
  it('top band hugs the inner top edge', () => {
    expect(spacingBandRect('padding', 'top', borderBox, 10, borders)).toEqual({
      left: 108, // 100 + borderLeft 8
      top: 52, //  50 + borderTop 2
      width: 188, // 200 − 8 − 4
      height: 10,
    })
  })

  it('bottom band hugs the inner bottom edge', () => {
    expect(spacingBandRect('padding', 'bottom', borderBox, 10, borders)).toEqual({
      left: 108,
      top: 114, // 50 + 2 + (80 − 2 − 6) − 10
      width: 188,
      height: 10,
    })
  })

  it('right band hugs the inner right edge, spanning the inner height', () => {
    expect(spacingBandRect('padding', 'right', borderBox, 14, borders)).toEqual({
      left: 282, // 100 + 8 + 188 − 14
      top: 52,
      width: 14,
      height: 72, // 80 − 2 − 6
    })
  })

  it('a zero side yields a degenerate band at the edge (chip anchor only)', () => {
    expect(spacingBandRect('padding', 'top', borderBox, 0, noBorders)).toEqual({
      left: 100,
      top: 50,
      width: 200,
      height: 0,
    })
  })
})

describe('negative margin bands', () => {
  const borderBox = { left: 100, top: 50, width: 300, height: 200 }
  const noBorders = { top: 0, right: 0, bottom: 0, left: 0 }

  it('draws a negative top margin INSIDE the top edge, not above it', () => {
    const positive = spacingBandRect('margin', 'top', borderBox, 20, noBorders)
    const negative = spacingBandRect('margin', 'top', borderBox, 20, noBorders, true)

    // Positive pushes away from the box; negative covers the space the
    // element pulled past its own top edge.
    expect(positive.top).toBe(30)
    expect(negative.top).toBe(50)
    expect(negative.height).toBe(20)
  })

  it('anchors a negative bottom/right band to the far edge', () => {
    const bottom = spacingBandRect('margin', 'bottom', borderBox, 30, noBorders, true)
    expect(bottom.top).toBe(220) // 50 + 200 - 30
    const right = spacingBandRect('margin', 'right', borderBox, 30, noBorders, true)
    expect(right.left).toBe(370) // 100 + 300 - 30
  })
})
