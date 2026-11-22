/** Parse and serialize gradients that the visual editor can represent. */

import { splitCssList } from '@ui/lib/cssValueList'
import { findColorVariable, type ColorVariable } from '@ui/lib/colorVariable'
import { clamp } from '@ui/lib/clamp'
import {
  formatColor,
  parseColor,
  type ColorFormat,
  type Rgba,
} from './colorMath'

export type GradientKind = 'linear' | 'radial' | 'conic'

export interface GradientStop {
  color: Rgba
  tokenName?: string
  /** 0–1 along the gradient line. */
  pos: number
}

export interface Gradient {
  kind: GradientKind
  /** Radial gradients default to an ellipse when no shape is authored. */
  radialShape?: 'ellipse' | 'circle'
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
}

export function parseGradient(input: string, tokens: readonly ColorVariable[] = []): Gradient | null {
  const match = GRADIENT_RE.exec(input.trim())
  if (!match) return null
  const kind = match[1].toLowerCase() as GradientKind
  const args = splitCssList(match[2])
  if (args.length === 0) return null

  let angle = kind === 'conic' ? 0 : 180
  let radialShape: Gradient['radialShape']
  let stopArgs = args
  const first = args[0].toLowerCase()
  if (kind === 'radial') {
    radialShape = first === 'circle' ? 'circle' : 'ellipse'
    if (first === 'circle' || first === 'ellipse') stopArgs = args.slice(1)
  } else {
    const anglePattern = kind === 'conic' ? /^from\s+([+-]?[\d.]+)deg$/ : /^([+-]?[\d.]+)deg$/
    const deg = anglePattern.exec(first)
    if (deg && Number.isFinite(Number(deg[1]))) {
      angle = normalizeAngle(Number(deg[1]))
      stopArgs = args.slice(1)
    } else if (kind === 'linear' && Object.hasOwn(SIDE_ANGLES, first)) {
      angle = SIDE_ANGLES[first]
      stopArgs = args.slice(1)
    }
  }

  if (stopArgs.length < 2) return null

  const raw: Array<Omit<GradientStop, 'pos'> & { pos: number | null }> = []
  for (const arg of stopArgs) {
    const { colorText, pos } = splitStop(arg)
    const token = findColorVariable(colorText, tokens)
    const color = parseColor(token?.value ?? colorText)
    if (!color || (pos !== null && (pos < 0 || pos > 1))) return null
    raw.push({ color, pos, tokenName: token?.name })
  }

  return { kind, angle, radialShape, stops: distributePositions(raw) }
}

export function formatGradient(gradient: Gradient, format: ColorFormat): string {
  const stops = [...gradient.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((stop) => `${stop.tokenName ? `var(${stop.tokenName})` : formatColor(stop.color, format)} ${formatPercent(stop.pos)}%`)
    .join(', ')
  if (gradient.kind === 'linear') {
    return `linear-gradient(${normalizeAngle(gradient.angle)}deg, ${stops})`
  }
  if (gradient.kind === 'conic') {
    return `conic-gradient(from ${normalizeAngle(gradient.angle)}deg, ${stops})`
  }
  return `radial-gradient(${gradient.radialShape ?? 'circle'}, ${stops})`
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

function splitStop(arg: string): { colorText: string; pos: number | null } {
  const match = /^(.*?)\s+(-?\d+(?:\.\d+)?)%$/.exec(arg.trim())
  if (!match) return { colorText: arg.trim(), pos: null }
  return {
    colorText: match[1].trim(),
    pos: Number.parseFloat(match[2]) / 100,
  }
}

/** Fill in missing stop positions the way CSS does: ends pinned, gaps evened. */
function distributePositions(
  raw: ReadonlyArray<Omit<GradientStop, 'pos'> & { pos: number | null }>,
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
  return raw.map((stop, index) => ({ ...stop, pos: positions[index] ?? 0 }))
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
