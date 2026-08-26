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

const HEX_RE = /^#([0-9a-f]{3,8})$/i
const RGB_RE = /^rgba?\(([^()]+)\)$/i
const HSL_RE = /^hsla?\(([^()]+)\)$/i

/** Safe-to-inline CSS colour values (also permits `var(--token)` references). */
const HEX_SWATCH_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION_SWATCH_RE = /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.%\s,+/-]+\)$/i
const CSS_VARIABLE_RE = /^var\(--[a-z0-9_-]+\)$/i

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, value))
}

/**
 * Guard a value before it is written into an inline CSS custom property.
 * Anything that isn't a plain hex / colour-function / `var()` reference —
 * or that carries CSS or markup punctuation — collapses to `fallback`.
 */
export function safeCssColor(value: unknown, fallback = '#000000'): string {
  const next = typeof value === 'string' ? value.trim() : ''
  if (!next || next.length > 120) return fallback
  if (/[;{}<>]/.test(next)) return fallback
  if (HEX_SWATCH_RE.test(next)) return next
  if (FUNCTION_SWATCH_RE.test(next)) return next
  if (CSS_VARIABLE_RE.test(next)) return next
  return fallback
}

export function parseColor(input: string): Rgba | null {
  const value = input.trim()
  if (!value) return null

  const hex = HEX_RE.exec(value)
  if (hex) return parseHex(hex[1])

  const rgb = RGB_RE.exec(value)
  if (rgb) {
    const parts = splitArgs(rgb[1])
    if (parts.length < 3) return null
    return {
      r: parseChannel(parts[0]),
      g: parseChannel(parts[1]),
      b: parseChannel(parts[2]),
      a: parseAlpha(parts[3]),
    }
  }

  const hsl = HSL_RE.exec(value)
  if (hsl) {
    const parts = splitArgs(hsl[1])
    if (parts.length < 3) return null
    return hslToRgba(
      normalizeHue(Number.parseFloat(parts[0])),
      clamp(Number.parseFloat(parts[1]) / 100, 0, 1),
      clamp(Number.parseFloat(parts[2]) / 100, 0, 1),
      parseAlpha(parts[3]),
    )
  }

  return null
}

export function formatColor(rgba: Rgba, format: ColorFormat): string {
  const r = Math.round(clamp(rgba.r, 0, 255))
  const g = Math.round(clamp(rgba.g, 0, 255))
  const b = Math.round(clamp(rgba.b, 0, 255))
  const a = roundAlpha(rgba.a)

  if (format === 'rgb') {
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`
  }

  if (format === 'hsl') {
    const { h, s, l } = rgbToHsl({ r, g, b, a })
    const hh = Math.round(h)
    const ss = Math.round(s * 100)
    const ll = Math.round(l * 100)
    return a === 1
      ? `hsl(${hh}, ${ss}%, ${ll}%)`
      : `hsla(${hh}, ${ss}%, ${ll}%, ${a})`
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

function splitArgs(body: string): string[] {
  return body
    .split(/[\s,/]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

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
  return Math.round(clamp(value, 0, 1) * 100) / 100
}

function toHex(value: number): string {
  return Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0')
}
