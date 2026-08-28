/**
 * effectsModel — box-shadow / filter translation for the Effects section.
 *
 * The dangerous failures here are silent: a shadow list that loses an entry
 * on round-trip, or a `filter` whose grayscale() disappears because the panel
 * only knew about blur. Both would rewrite CSS the user never touched.
 */
import { describe, expect, it } from 'bun:test'
import {
  formatShadow,
  formatShadowList,
  parseShadowList,
  readBlur,
  shadowSummary,
  writeBlur,
} from '@admin/pages/site/panels/PropertiesPanel/effectsModel'

describe('parseShadowList', () => {
  it('keeps a colour function whole despite its commas', () => {
    const list = parseShadowList('0 4px 8px rgba(0, 0, 0, 0.25)')
    expect(list).toHaveLength(1)
    expect(list[0].color).toBe('rgba(0, 0, 0, 0.25)')
    expect(list[0].blur).toBe('8px')
  })

  it('splits a multi-shadow list and reads the inset keyword', () => {
    const list = parseShadowList('0 1px 2px #000, inset 0 0 4px 1px rgb(255, 0, 0)')
    expect(list).toHaveLength(2)
    expect(list[0].inset).toBe(false)
    expect(list[1].inset).toBe(true)
    expect(list[1].spread).toBe('1px')
  })

  it('round-trips an untouched declaration', () => {
    const source = '0 4px 8px 2px rgba(0, 0, 0, 0.25)'
    expect(formatShadowList(parseShadowList(source))).toBe(source)
  })

  it('treats none / empty as no shadows', () => {
    expect(parseShadowList('none')).toEqual([])
    expect(parseShadowList('')).toEqual([])
    expect(parseShadowList(undefined)).toEqual([])
  })

  it('skips a declaration too short to be an editable shadow', () => {
    expect(parseShadowList('inherit')).toEqual([])
  })

  it('keeps a var() colour as written instead of resolving it', () => {
    const list = parseShadowList('0 2px 4px var(--brand)')
    expect(list[0].color).toBe('var(--brand)')
    expect(formatShadow(list[0])).toBe('0 2px 4px 0 var(--brand)')
  })
})

describe('shadowSummary', () => {
  it('reads as the prototype row value: offsets, then blur', () => {
    expect(shadowSummary(parseShadowList('0 4px 4px #000')[0])).toBe('0 4 · 4px')
  })
})

describe('filter blur', () => {
  it('reads the blur argument out of a filter list', () => {
    expect(readBlur('grayscale(50%) blur(4px)')).toBe('4px')
    expect(readBlur('grayscale(50%)')).toBeNull()
    expect(readBlur('none')).toBeNull()
  })

  it('writes the blur without dropping the other filter functions', () => {
    expect(writeBlur('grayscale(50%)', '6px')).toBe('blur(6px) grayscale(50%)')
    expect(writeBlur('blur(2px) grayscale(50%)', '6px')).toBe('blur(6px) grayscale(50%)')
  })

  it('clears the property when removing the only function', () => {
    expect(writeBlur('blur(2px)', null)).toBeUndefined()
    expect(writeBlur('blur(2px) grayscale(50%)', null)).toBe('grayscale(50%)')
  })

  it('starts from nothing when the property held none', () => {
    expect(writeBlur('none', '4px')).toBe('blur(4px)')
    expect(writeBlur(undefined, '4px')).toBe('blur(4px)')
  })
})
