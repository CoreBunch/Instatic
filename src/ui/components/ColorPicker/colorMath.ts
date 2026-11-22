/**
 * Colour maths for the rich colour picker.
 *
 * Parsing accepts every notation the editor persists — `#rgb`, `#rgba`,
 * `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` and `hsl()/hsla()` in both the legacy
 * comma syntax and the modern space/slash syntax. Formatting emits the three
 * notations the picker's format selector offers.
 *
 * The picker keeps its interactive state in HSV (not HSL) because a
 * saturation/brightness square maps 1:1 onto the S and V axes — dragging in
 * HSL would make the handle drift.
 */

import { clamp } from '@ui/lib/clamp'

export interface Rgba {
  /** 0–255 */
  r: number
  /** 0–255 */
  g: number
  /** 0–255 */
  b: number
  /** 0–1 */
  a: number
}

export interface Hsva {
  /** 0–360 */
  h: number
  /** 0–1 */
  s: number
  /** 0–1 */
  v: number
  /** 0–1 */
  a: number
}

export const COLOR_FORMATS = ['hex', 'rgb', 'hsl'] as const
export type ColorFormat = (typeof COLOR_FORMATS)[number]

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION_RE = /^(rgb|hsl)a?\(([^()]+)\)$/i
const CHANNEL_RE = /^[+-]?(?:\d*\.)?\d+%?$/
const HUE_RE = /^([+-]?(?:\d*\.)?\d+)(deg|grad|turn|rad)?$/i

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

export function parseColor(input: string): Rgba | null {
  const value = input.trim()
  if (!value) return null

  const hex = HEX_RE.exec(value)
  if (hex) return parseHex(hex[1])

  if (value.toLowerCase() === 'transparent') return { ...BLACK, a: 0 }
  const fn = FUNCTION_RE.exec(value)
  if (!fn) return null
  const body = fn[2].trim()
  const legacy = body.includes(',')
  const [channels, alpha, ...extra] = legacy ? [body] : body.split('/')
  if (extra.length) return null
  const parts = legacy ? channels.split(',').map((part) => part.trim()) : channels.trim().split(/\s+/)
  const opacity = legacy && parts.length === 4 ? parts.pop() : alpha?.trim()
  if (parts.length !== 3 || (opacity !== undefined && !CHANNEL_RE.test(opacity))) return null
  const [first, second, third] = parts
  const a = parseAlpha(opacity)
  if (fn[1].toLowerCase() === 'rgb') {
    if (!parts.every((part) => CHANNEL_RE.test(part))) return null
    return { r: parseChannel(first), g: parseChannel(second), b: parseChannel(third), a }
  }
  const hue = HUE_RE.exec(first)
  if (!hue || ![second, third].every((part) => CHANNEL_RE.test(part) && part.endsWith('%'))) return null
  const units = hue[2]?.toLowerCase()
  const factor = units === 'turn' ? 360 : units === 'rad' ? 180 / Math.PI : units === 'grad' ? 0.9 : 1
  return hslToRgba(normalizeHue(Number(hue[1]) * factor),
    clamp(parseFloat(second) / 100, 0, 1), clamp(parseFloat(third) / 100, 0, 1), a)
}

export function formatColor(rgba: Rgba, format: ColorFormat): string {
  const r = Math.round(clamp(rgba.r, 0, 255))
  const g = Math.round(clamp(rgba.g, 0, 255))
  const b = Math.round(clamp(rgba.b, 0, 255))
  const a = clamp(rgba.a, 0, 1)

  if (format === 'rgb') {
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundAlpha(a)})`
  }

  if (format === 'hsl') {
    const { h, s, l } = rgbToHsl({ r, g, b, a })
    const hh = Math.round(h)
    const ss = Math.round(s * 100)
    const ll = Math.round(l * 100)
    return a === 1
      ? `hsl(${hh}, ${ss}%, ${ll}%)`
      : `hsla(${hh}, ${ss}%, ${ll}%, ${roundAlpha(a)})`
  }

  const base = `#${toHex(r)}${toHex(g)}${toHex(b)}`
  return a === 1 ? base : `${base}${toHex(a * 255)}`
}

export function rgbaToHsva({ r, g, b, a }: Rgba): Hsva {
  const rn = clamp(r, 0, 255) / 255
  const gn = clamp(g, 0, 255) / 255
  const bn = clamp(b, 0, 255) / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else h = (rn - gn) / delta + 4
    h = normalizeHue(h * 60)
  }

  return { h, s: max === 0 ? 0 : delta / max, v: max, a: clamp(a, 0, 1) }
}

export function hsvaToRgba({ h, s, v, a }: Hsva): Rgba {
  const hue = normalizeHue(h)
  const sat = clamp(s, 0, 1)
  const val = clamp(v, 0, 1)
  const c = val * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = val - c
  const [r, g, b] = sectorChannels(hue, c, x)
  return {
    r: (r + m) * 255,
    g: (g + m) * 255,
    b: (b + m) * 255,
    a: clamp(a, 0, 1),
  }
}

/** The fully saturated, fully bright hue — the saturation square's base layer. */
export function hueCss(h: number): string {
  return formatColor(hsvaToRgba({ h, s: 1, v: 1, a: 1 }), 'hex')
}

/** The current colour at full opacity — the alpha track's gradient end stop. */
export function opaqueCss(hsva: Hsva): string {
  return formatColor(hsvaToRgba({ ...hsva, a: 1 }), 'hex')
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseHex(digits: string): Rgba | null {
  const expand = (pair: string) => Number.parseInt(pair, 16)
  if (digits.length === 3 || digits.length === 4) {
    const [r, g, b, a] = digits.split('')
    return {
      r: expand(r + r),
      g: expand(g + g),
      b: expand(b + b),
      a: a === undefined ? 1 : expand(a + a) / 255,
    }
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: expand(digits.slice(0, 2)),
      g: expand(digits.slice(2, 4)),
      b: expand(digits.slice(4, 6)),
      a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1,
    }
  }
  return null
}

function parseChannel(token: string): number {
  if (token.endsWith('%')) return clamp(Number.parseFloat(token) * 2.55, 0, 255)
  return clamp(Number.parseFloat(token), 0, 255)
}

function parseAlpha(token: string | undefined): number {
  if (token === undefined) return 1
  if (token.endsWith('%')) return clamp(Number.parseFloat(token) / 100, 0, 1)
  return clamp(Number.parseFloat(token), 0, 1)
}

function hslToRgba(h: number, s: number, l: number, a: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = sectorChannels(h, c, x)
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a }
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  const l = (max + min) / 2

  if (delta === 0) return { h: 0, s: 0, l }

  const s = delta / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / delta) % 6
  else if (max === gn) h = (bn - rn) / delta + 2
  else h = (rn - gn) / delta + 4
  return { h: normalizeHue(h * 60), s, l }
}

/** The unshifted RGB triple for a hue sector, shared by the HSL and HSV paths. */
function sectorChannels(h: number, c: number, x: number): [number, number, number] {
  const hue = normalizeHue(h)
  if (hue < 60) return [c, x, 0]
  if (hue < 120) return [x, c, 0]
  if (hue < 180) return [0, c, x]
  if (hue < 240) return [0, x, c]
  if (hue < 300) return [x, 0, c]
  return [c, 0, x]
}

function normalizeHue(value: number): number {
  if (!Number.isFinite(value)) return 0
  return ((value % 360) + 360) % 360
}

function roundAlpha(value: number): number {
  return Math.round(value * 1000) / 1000
}

function toHex(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')
}
