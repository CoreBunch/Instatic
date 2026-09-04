/**
 * resolveTokenValue — the implicit unit a bare number gets.
 *
 * Every length field turns `16` into `16px`; line-height is the one place a
 * bare number IS the value, so its field passes an empty implicit unit and
 * `1.5` must stay `1.5` (the old default made it `1.5px` of leading).
 */
import { describe, expect, it } from 'bun:test'
import { resolveTokenValue } from '@site/property-controls/tokenUtils'

describe('resolveTokenValue implicit unit', () => {
  it('appends px to a bare number by default', () => {
    expect(resolveTokenValue('16', [])).toBe('16px')
  })

  it('keeps a bare number unitless when the field says so', () => {
    expect(resolveTokenValue('1.5', [], '')).toBe('1.5')
  })

  it('never touches an explicit unit or a function', () => {
    expect(resolveTokenValue('2em', [], '')).toBe('2em')
    expect(resolveTokenValue('calc(1em + 2px)', [], '')).toBe('calc(1em + 2px)')
  })
})
