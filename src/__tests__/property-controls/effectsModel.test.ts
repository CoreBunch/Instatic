/**
 * effectsModel — box-shadow / filter translation for the Effects section.
 *
 * The dangerous failures here are silent: a shadow list that loses an entry
 * on round-trip, or a `filter` whose grayscale() disappears because the panel
 * only knew about blur. Both would rewrite CSS the user never touched.
 */
import { describe, expect, it } from 'bun:test'
import {
  changeShadow,
  readEffects,
  formatShadow,
  readBlur,
  shadowSummary,
  writeBlur,
} from '@admin/pages/site/panels/PropertiesPanel/effectsModel'

function readShadows(boxShadow: unknown) {
  return readEffects({ boxShadow }).flatMap((entry) => entry.shadow ? [entry.shadow] : [])
}

describe('reading shadows', () => {
  it('keeps a colour function whole despite its commas', () => {
    const list = readShadows('0 4px 8px rgba(0, 0, 0, 0.25)')
    expect(list).toHaveLength(1)
    expect(list[0].color).toBe('rgba(0, 0, 0, 0.25)')
    expect(list[0].blur).toBe('8px')
  })

  it('splits a multi-shadow list and reads the inset keyword', () => {
    const list = readShadows('0 1px 2px #000, inset 0 0 4px 1px rgb(255, 0, 0)')
    expect(list).toHaveLength(2)
    expect(list[0].inset).toBe(false)
    expect(list[1].inset).toBe(true)
    expect(list[1].spread).toBe('1px')
  })

  it('round-trips an untouched declaration', () => {
    const source = '0 4px 8px 2px rgba(0, 0, 0, 0.25)'
    expect(formatShadow(readShadows(source)[0])).toBe(source)
  })

  it('treats none / empty as no shadows', () => {
    expect(readShadows('none')).toEqual([])
    expect(readShadows('')).toEqual([])
    expect(readShadows(undefined)).toEqual([])
  })

  it('skips a declaration too short to be an editable shadow', () => {
    expect(readShadows('inherit')).toEqual([])
  })

  it('keeps a var() colour as written instead of resolving it', () => {
    const list = readShadows('0 2px 4px var(--brand)')
    expect(list[0].color).toBe('var(--brand)')
    expect(formatShadow(list[0])).toBe('0 2px 4px 0 var(--brand)')
  })
})

describe('shadowSummary', () => {
  it('reads as the prototype row value: offsets, then blur', () => {
    expect(shadowSummary(readShadows('0 4px 4px #000')[0])).toBe('0 4 · 4px')
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

it('edits a shadow without rewriting an imported sibling layer', () => {
  const value = 'var(--card-shadow), inset 0 2px 4px #fff'
  const [entry] = readEffects({ boxShadow: value })
  expect(entry.shadowIndex).toBe(1)
  expect(changeShadow(value, 1, null)).toBe('var(--card-shadow)')
})

it('preserves filter order and nested blur arguments', () => {
  const value = 'contrast(2) blur(var(--soften)) saturate(.8)'
  expect(readBlur(value)).toBe('var(--soften)')
  expect(writeBlur(value, '8px')).toBe('contrast(2) blur(8px) saturate(.8)')
})

it('replaces CSS-wide keywords when adding an effect', () => {
  expect(writeBlur('inherit', '6px')).toBe('blur(6px)')
  expect(changeShadow('revert-layer', null, readShadows('0 2px 4px red')[0])).toBe('0 2px 4px 0 red')
})
