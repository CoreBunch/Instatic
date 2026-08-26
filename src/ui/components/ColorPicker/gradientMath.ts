/**
 * Gradient maths for the rich colour picker.
 *
 * Parses the gradient shapes the picker edits — `linear-gradient(...)`,
 * `radial-gradient(...)` and `conic-gradient(...)` — into a stop list the picker's fill tabs can
 * manipulate, and formats them back to canonical CSS. Stops whose colour the
 * solid-colour parser cannot read (`var()` references, `color-mix(...)`)
 * make the whole gradient unparseable on purpose: the picker then starts
 * from its defaults instead of silently corrupting a hand-authored value.
 *
 * Formatting is canonical by construction (numeric angle, sorted stops,
 * `formatColor` output), which is what makes a formatted gradient safe to
 * write into an inline CSS custom property without further escaping.
 */

import {
  clamp,
  formatColor,
  parseColor,
  type ColorFormat,
  type Rgba,
} from './colorMath'

export type GradientKind = 'linear' | 'radial' | 'conic'

export interface GradientStop {
  color: Rgba
  /** 0–1 along the gradient line. */
  pos: number
}

export interface Gradient {
  kind: GradientKind
  /** Degrees — linear direction / conic `from` angle. Radial ignores it. */
  angle: number
  /** At least two stops, sorted by `pos`. */
  stops: GradientStop[]
}

const GRADIENT_RE = /^(linear|radial|conic)-gradient\((.*)\)$/is

/** CSS `to <side>` keywords mapped onto their angle equivalents. */
const SIDE_ANGLES: Record<string, number> = {
  'to top': 0,
  'to right': 90,
  'to bottom': 180,
  'to left': 270,
  'to top right': 45,
  'to right top': 45,
  'to bottom right': 135,
  'to right bottom': 135,
  'to bottom left': 225,
  'to left bottom': 225,
  'to top left': 315,
  'to left top': 315,
}

export function isGradient(value: string): boolean {
  return GRADIENT_RE.test(value.trim())
}

export function parseGradient(input: string): Gradient | null {
  const match = GRADIENT_RE.exec(input.trim())
  if (!match) return null
  const kind = match[1].toLowerCase() as GradientKind
  const args = splitTopLevel(match[2])
  if (args.length === 0) return null

  let angle = kind === 'conic' ? 0 : 180
  let stopArgs = args

  if (kind === 'conic') {
    const from = /^from\s+(-?\d+(?:\.\d+)?)deg(?:\s+at\s+.*)?$/.exec(args[0].toLowerCase())
    if (from) {
      angle = normalizeAngle(Number.parseFloat(from[1]))
      stopArgs = args.slice(1)
    } else if (!splitStop(args[0]).colorText || parseColor(splitStop(args[0]).colorText) === null) {
      // `at center` and friends — dropped; the picker re-emits only `from`.
      stopArgs = args.slice(1)
    }
  } else if (kind === 'linear') {
    const first = args[0].toLowerCase()
    const deg = /^(-?\d+(?:\.\d+)?)deg$/.exec(first)
    if (deg) {
      angle = normalizeAngle(Number.parseFloat(deg[1]))
      stopArgs = args.slice(1)
    } else if (first in SIDE_ANGLES) {
      angle = SIDE_ANGLES[first]
      stopArgs = args.slice(1)
    } else if (first.startsWith('to ')) {
      return null
    }
  } else if (!splitStop(args[0]).colorText || parseColor(splitStop(args[0]).colorText) === null) {
    // Radial preludes (`circle`, `ellipse at center`, ...) are dropped — the
    // picker always re-emits `circle`.
    stopArgs = args.slice(1)
  }

  if (stopArgs.length < 2) return null

  const raw: Array<{ color: Rgba; pos: number | null }> = []
  for (const arg of stopArgs) {
    const { colorText, pos } = splitStop(arg)
    const color = parseColor(colorText)
    if (!color) return null
    raw.push({ color, pos })
  }

  return { kind, angle, stops: distributePositions(raw) }
}

export function formatGradient(gradient: Gradient, format: ColorFormat): string {
  const stops = [...gradient.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((stop) => `${formatColor(stop.color, format)} ${formatPercent(stop.pos)}%`)
    .join(', ')
  if (gradient.kind === 'linear') {
    return `linear-gradient(${Math.round(normalizeAngle(gradient.angle))}deg, ${stops})`
  }
  if (gradient.kind === 'conic') {
    return `conic-gradient(from ${Math.round(normalizeAngle(gradient.angle))}deg, ${stops})`
  }
  return `radial-gradient(circle, ${stops})`
}

/** The colour at `pos`, linearly interpolated between the surrounding stops. */
export function gradientColorAt(stops: readonly GradientStop[], pos: number): Rgba {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos)
  const at = clamp(pos, 0, 1)
  if (sorted.length === 0) return { r: 0, g: 0, b: 0, a: 1 }
  if (at <= sorted[0].pos) return { ...sorted[0].color }
  const last = sorted[sorted.length - 1]
  if (at >= last.pos) return { ...last.color }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const next = sorted[i]
    if (at > next.pos) continue
    const span = next.pos - prev.pos
    const t = span === 0 ? 0 : (at - prev.pos) / span
    return {
      r: lerp(prev.color.r, next.color.r, t),
      g: lerp(prev.color.g, next.color.g, t),
      b: lerp(prev.color.b, next.color.b, t),
      a: lerp(prev.color.a, next.color.a, t),
    }
  }
  return { ...last.color }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Split on commas that sit outside parentheses (`rgb(1, 2, 3)` stays whole). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === '(') depth++
    else if (char === ')') depth--
    if (char === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  const tail = current.trim()
  if (tail) parts.push(tail)
  return parts
}

function splitStop(arg: string): { colorText: string; pos: number | null } {
  const match = /^(.*?)\s+(-?\d+(?:\.\d+)?)%$/.exec(arg.trim())
  if (!match) return { colorText: arg.trim(), pos: null }
  return {
    colorText: match[1].trim(),
    pos: clamp(Number.parseFloat(match[2]) / 100, 0, 1),
  }
}

/** Fill in missing stop positions the way CSS does: ends pinned, gaps evened. */
function distributePositions(
  raw: ReadonlyArray<{ color: Rgba; pos: number | null }>,
): GradientStop[] {
  const positions = raw.map((stop) => stop.pos)
  if (positions[0] === null) positions[0] = 0
  if (positions[positions.length - 1] === null) positions[positions.length - 1] = 1
  let lastKnown = 0
  for (let i = 1; i < positions.length; i++) {
    const pos = positions[i]
    if (pos === null) continue
    // CSS clamps a stop that would move backwards to the running maximum.
    positions[i] = Math.max(pos, positions[lastKnown] ?? 0)
    for (let j = lastKnown + 1; j < i; j++) {
      const t = (j - lastKnown) / (i - lastKnown)
      positions[j] = (positions[lastKnown] ?? 0) + t * ((positions[i] ?? 1) - (positions[lastKnown] ?? 0))
    }
    lastKnown = i
  }
  return raw.map((stop, index) => ({ color: stop.color, pos: positions[index] ?? 0 }))
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

function normalizeAngle(value: number): number {
  if (!Number.isFinite(value)) return 180
  return ((value % 360) + 360) % 360
}

function formatPercent(pos: number): number {
  return Math.round(clamp(pos, 0, 1) * 1000) / 10
}
