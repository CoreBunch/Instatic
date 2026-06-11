/**
 * canvasOverlayGeometry — pure-function tests for the overlay coordinate
 * helpers. `unionCanvasOverlayRects` is fully deterministic and directly
 * testable; `measureCanvasElementRect`'s null/zero-size guards are too. The
 * scaled-measurement path needs a live, transformed iframe (covered by the
 * canvas integration paths), so only the guards are asserted here.
 */
import { describe, it, expect } from 'bun:test'
import {
  measureCanvasElementRect,
  unionCanvasOverlayRects,
  type CanvasOverlayRect,
} from '@site/canvas/canvasOverlayGeometry'

describe('unionCanvasOverlayRects', () => {
  const a: CanvasOverlayRect = { x: 0, y: 0, width: 10, height: 10 }

  it('returns b unchanged when a is null', () => {
    const b: CanvasOverlayRect = { x: 5, y: 5, width: 4, height: 4 }
    expect(unionCanvasOverlayRects(null, b)).toEqual(b)
  })

  it('produces the smallest rect containing both inputs', () => {
    const b: CanvasOverlayRect = { x: 20, y: 30, width: 10, height: 10 }
    expect(unionCanvasOverlayRects(a, b)).toEqual({ x: 0, y: 0, width: 30, height: 40 })
  })

  it('handles a fully-contained rect (union equals the outer rect)', () => {
    const inner: CanvasOverlayRect = { x: 2, y: 2, width: 4, height: 4 }
    expect(unionCanvasOverlayRects(a, inner)).toEqual(a)
  })

  it('handles negative origins', () => {
    const neg: CanvasOverlayRect = { x: -5, y: -5, width: 2, height: 2 }
    expect(unionCanvasOverlayRects(a, neg)).toEqual({ x: -5, y: -5, width: 15, height: 15 })
  })
})

describe('measureCanvasElementRect', () => {
  it('returns null for a null target without touching the iframe', () => {
    // iframe is never read on the null-target fast path, so a bare object is fine.
    const fakeIframe = {} as unknown as HTMLIFrameElement
    expect(measureCanvasElementRect(null, fakeIframe, null)).toBeNull()
  })
})
