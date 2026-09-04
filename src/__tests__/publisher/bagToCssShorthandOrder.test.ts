/**
 * bagToCSS — a shorthand never overwrites the longhands it covers.
 *
 * Bags are insertion-ordered, so a `border` shorthand added AFTER the
 * per-side rows used to be emitted after them and win the cascade — the
 * inspector's Border popout writes longhands, the Styles "+" menu can add the
 * shorthand later, and the 4px the user typed vanished.
 */
import { describe, expect, it } from 'bun:test'
import { bagToCSS } from '@core/publisher'

function order(css: string): string[] {
  return css
    .split('\n')
    .map((line) => line.trim().split(':')[0])
    .filter(Boolean)
}

describe('bagToCSS shorthand ordering', () => {
  it('emits a shorthand before the longhands it covers, whatever the insertion order', () => {
    const css = bagToCSS({
      borderTopWidth: '4px',
      borderTopStyle: 'solid',
      border: '1px dashed blue',
      borderTop: '2px dotted red',
    })
    expect(order(css)).toEqual(['border', 'border-top', 'border-top-width', 'border-top-style'])
  })

  it('leaves unrelated declarations in their original order', () => {
    const css = bagToCSS({ opacity: 0.5, width: '10px', color: 'red' })
    expect(order(css)).toEqual(['opacity', 'width', 'color'])
  })
})
