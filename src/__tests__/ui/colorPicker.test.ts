import { describe, expect, it } from 'bun:test'
import {
  formatColor,
  hsvaToRgba,
  parseColor,
  rgbaToHsva,
  safeCssColor,
} from '@ui/components/ColorPicker'

describe('colour picker maths', () => {
  it('parses every notation the editor persists', () => {
    expect(parseColor('#4455ff')).toEqual({ r: 0x44, g: 0x55, b: 0xff, a: 1 })
    expect(parseColor('#45f')).toEqual({ r: 0x44, g: 0x55, b: 0xff, a: 1 })
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.502, 3)
    expect(parseColor('rgb(255, 0, 128)')).toEqual({ r: 255, g: 0, b: 128, a: 1 })
    expect(parseColor('rgb(255 0 128 / 50%)')?.a).toBe(0.5)
    const hsl = parseColor('hsla(238, 100%, 62%, 1)')!
    expect(Math.round(hsl.r)).toBe(61)
    expect(Math.round(hsl.g)).toBe(68)
    expect(Math.round(hsl.b)).toBe(255)
    expect(hsl.a).toBe(1)
    expect(parseColor('not-a-colour')).toBeNull()
  })

  it('formats in each notation, dropping alpha when opaque', () => {
    const rgba = { r: 255, g: 0, b: 128, a: 1 }
    expect(formatColor(rgba, 'hex')).toBe('#ff0080')
    expect(formatColor(rgba, 'rgb')).toBe('rgb(255, 0, 128)')
    expect(formatColor(rgba, 'hsl')).toBe('hsl(330, 100%, 50%)')
    expect(formatColor({ ...rgba, a: 0.5 }, 'hex')).toBe('#ff008080')
    expect(formatColor({ ...rgba, a: 0.5 }, 'rgb')).toBe('rgba(255, 0, 128, 0.5)')
    expect(formatColor({ ...rgba, a: 0.5 }, 'hsl')).toBe('hsla(330, 100%, 50%, 0.5)')
  })

  it('round-trips RGB through HSV', () => {
    for (const input of ['#ff0080', '#4455ff', '#000000', '#ffffff', '#808080']) {
      const rgba = parseColor(input)!
      expect(formatColor(hsvaToRgba(rgbaToHsva(rgba)), 'hex')).toBe(input)
    }
  })

  it('only lets safe CSS colour values reach an inline custom property', () => {
    expect(safeCssColor('hsla(238, 100%, 62%, 1)')).toBe('hsla(238, 100%, 62%, 1)')
    expect(safeCssColor('var(--primary)')).toBe('var(--primary)')
    expect(safeCssColor('red; color: blue')).toBe('#000000')
    expect(safeCssColor(undefined)).toBe('#000000')
  })
})
