/**
 * Fill-state model for the colour picker: one value that is either a solid
 * colour or a gradient under construction. The picker's whole solid-colour
 * surface (saturation square, tracks, text fields) edits `hsva` in solid
 * mode and the selected stop's `hsva` in a gradient mode; these helpers keep
 * that state's construction and CSS emission in one place.
 */

import {
  BLACK,
  formatColor,
  hsvaToRgba,
  parseColor,
  rgbaToHsva,
  type ColorFormat,
  type Hsva,
} from './colorMath'
import { formatGradient, parseGradient, type GradientKind } from './gradientMath'

export type FillMode = 'solid' | GradientKind

export interface StopState {
  hsva: Hsva
  /** 0–1 along the gradient line. */
  pos: number
}

export interface FillState {
  mode: FillMode
  /** The solid colour — and the seed for a fresh gradient. */
  hsva: Hsva
  stops: StopState[]
  /** Degrees, linear gradients only. */
  angle: number
}

export function initialFill(value: string, gradients: boolean): FillState {
  if (gradients) {
    const gradient = parseGradient(value)
    if (gradient) {
      const stops = gradient.stops.map((stop) => ({
        hsva: rgbaToHsva(stop.color),
        pos: stop.pos,
      }))
      return { mode: gradient.kind, hsva: stops[0].hsva, stops, angle: gradient.angle }
    }
  }
  const hsva = rgbaToHsva(parseColor(value) ?? BLACK)
  return { mode: 'solid', hsva, stops: defaultStops(hsva), angle: 180 }
}

/** Fresh gradient seed: the current colour fading to its transparent self. */
export function defaultStops(hsva: Hsva): StopState[] {
  return [
    { hsva, pos: 0 },
    { hsva: { ...hsva, a: 0 }, pos: 1 },
  ]
}

export function formatFill(fill: FillState, format: ColorFormat): string {
  if (fill.mode === 'solid') return formatColor(hsvaToRgba(fill.hsva), format)
  return formatGradient(
    {
      kind: fill.mode,
      angle: fill.angle,
      stops: fill.stops.map((stop) => ({ color: hsvaToRgba(stop.hsva), pos: stop.pos })),
    },
    format,
  )
}

export function nearestStop(stops: readonly StopState[], pos: number): number {
  let index = -1
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < stops.length; i++) {
    const distance = Math.abs(stops[i].pos - pos)
    if (distance < best) {
      best = distance
      index = i
    }
  }
  return index
}
