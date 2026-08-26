import { describe, expect, it } from 'bun:test'
import {
  formatColor,
  formatGradient,
  gradientColorAt,
  hsvaToRgba,
  parseColor,
  parseGradient,
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

describe('gradient maths', () => {
  it('round-trips a linear gradient with explicit angle and positions', () => {
    const css = 'linear-gradient(45deg, #ff0080 0%, rgba(0, 0, 255, 0.5) 100%)'
    const gradient = parseGradient(css)!
    expect(gradient.kind).toBe('linear')
    expect(gradient.angle).toBe(45)
    expect(gradient.stops).toHaveLength(2)
    expect(formatGradient(gradient, 'hex')).toBe(
      'linear-gradient(45deg, #ff0080 0%, #0000ff80 100%)',
    )
  })

  it('defaults the angle and distributes missing stop positions', () => {
    const gradient = parseGradient('linear-gradient(#ff0000, #00ff00, #0000ff)')!
    expect(gradient.angle).toBe(180)
    expect(gradient.stops.map((stop) => stop.pos)).toEqual([0, 0.5, 1])
  })

  it('maps `to <side>` keywords onto angles', () => {
    expect(parseGradient('linear-gradient(to right, #000, #fff)')!.angle).toBe(90)
    expect(parseGradient('linear-gradient(to top left, #000, #fff)')!.angle).toBe(315)
  })

  it('parses radial gradients, dropping the shape prelude', () => {
    const gradient = parseGradient('radial-gradient(circle at center, #ff0000 10%, #0000ff 90%)')!
    expect(gradient.kind).toBe('radial')
    expect(formatGradient(gradient, 'hex')).toBe(
      'radial-gradient(circle, #ff0000 10%, #0000ff 90%)',
    )
  })

  it('round-trips a conic gradient with a from-angle', () => {
    const gradient = parseGradient('conic-gradient(from 45deg at center, #ff0000 0%, #0000ff 100%)')!
    expect(gradient.kind).toBe('conic')
    expect(gradient.angle).toBe(45)
    expect(formatGradient(gradient, 'hex')).toBe(
      'conic-gradient(from 45deg, #ff0000 0%, #0000ff 100%)',
    )
  })

  it('refuses gradients it could not re-emit faithfully', () => {
    expect(parseGradient('linear-gradient(var(--brand), #fff)')).toBeNull()
    expect(parseGradient('url(/uploads/x.jpg)')).toBeNull()
    expect(parseGradient('#ff0080')).toBeNull()
  })

  it('interpolates the colour at a strip position', () => {
    const gradient = parseGradient('linear-gradient(90deg, #000000 0%, #ffffff 100%)')!
    const mid = gradientColorAt(gradient.stops, 0.5)
    expect(Math.round(mid.r)).toBe(128)
    expect(Math.round(mid.g)).toBe(128)
    expect(Math.round(mid.b)).toBe(128)
  })
})
