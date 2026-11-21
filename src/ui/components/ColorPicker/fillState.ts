/**
 * Fill-state model for the colour picker: one value that is either a solid
 * colour or a gradient under construction. The picker's whole solid-colour
 * surface (saturation square, tracks, text fields) edits `hsva` in solid
 * mode and the selected stop's `hsva` in a gradient mode; these helpers keep
 * that state's construction and CSS emission in one place.
 */

import type { ColorVariable } from '@ui/lib/colorVariable'
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

interface StopState {
  hsva: Hsva
  tokenName?: string
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
  radialShape?: 'circle' | 'ellipse'
}

export function initialFill(value: string, gradients: boolean, tokens?: readonly ColorVariable[]): FillState | null {
  if (gradients) {
    const gradient = parseGradient(value, tokens)
    if (gradient) {
      const stops = gradient.stops.map((stop) => ({
        hsva: rgbaToHsva(stop.color),
        pos: stop.pos,
        tokenName: stop.tokenName,
      }))
      return {
        mode: gradient.kind,
        hsva: stops[0].hsva,
        stops,
        angle: gradient.angle,
        radialShape: gradient.radialShape,
      }
    }
  }
  const color = value.trim() ? parseColor(value) : BLACK
  if (!color) return null
  const hsva = rgbaToHsva(color)
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
      radialShape: fill.radialShape,
      angle: fill.angle,
      stops: fill.stops.map((stop) => ({ color: hsvaToRgba(stop.hsva), pos: stop.pos, tokenName: stop.tokenName })),
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

/** Keep the selected stop when a canvas edit moves, rotates or reorders the gradient. */
export function reconcileStopSelection(previous: FillState | null, next: FillState | null, index: number): number {
  if (!next || next.mode === 'solid' || previous?.mode !== next.mode) return 0
  const previousStop = previous.stops[index]
  const fallbackIndex = Math.min(index, next.stops.length - 1)
  if (!previousStop) return fallbackIndex

  const matches = next.stops.map((stop, i) => ({ stop, i })).filter(({ stop }) =>
    previousStop.tokenName ? stop.tokenName === previousStop.tokenName :
      !stop.tokenName && formatColor(hsvaToRgba(stop.hsva), 'hex') === formatColor(hsvaToRgba(previousStop.hsva), 'hex'))
  const samePosition = matches.find(({ stop }) => stop.pos === previousStop.pos)
  return samePosition?.i ?? (matches.length === 1 ? matches[0].i : fallbackIndex)
}
