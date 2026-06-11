/**
 * canvasOverlayGeometry — pure-function tests for the inline-edit typography
 * scaling. (measureCanvasElementRect is exercised indirectly by the existing
 * overlay integration paths; the scaler is the new, directly-testable logic.)
 */
import { describe, it, expect } from 'bun:test'
import { scaleCssLength } from '@site/canvas/canvasOverlayGeometry'

describe('scaleCssLength', () => {
  it('scales px lengths by the iframe scale factor', () => {
    expect(scaleCssLength('32px', 0.5)).toBe('16px')
  })

  it('passes keywords through untouched', () => {
    expect(scaleCssLength('normal', 0.5)).toBe('normal')
  })

  it('handles fractional and negative px values', () => {
    expect(scaleCssLength('1.5px', 2)).toBe('3px')
    expect(scaleCssLength('-0.5px', 2)).toBe('-1px')
  })

  it('leaves non-px values untouched (unitless line-height, em)', () => {
    expect(scaleCssLength('1.4', 0.5)).toBe('1.4')
    expect(scaleCssLength('0.02em', 0.5)).toBe('0.02em')
  })
})
