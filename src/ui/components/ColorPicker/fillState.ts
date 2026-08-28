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

export type FillMode = 'solid' | GradientKind | 'image'

/** How the source covers its box — the four `background-size`/`repeat` pairs. */
export type ImageType = 'fill' | 'fit' | 'stretch' | 'tile'

/** The nine `background-position` anchors, as a 3×3 grid. */
export type ImagePosition =
  | 'left top'
  | 'center top'
  | 'right top'
  | 'left center'
  | 'center'
  | 'right center'
  | 'left bottom'
  | 'center bottom'
  | 'right bottom'

/** The image arm of a fill: a `url(...)` source plus how it lays out. */
export interface ImageState {
  /** Empty until a source is picked. */
  url: string
  type: ImageType
  position: ImagePosition
}

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
  /** The image arm — carried alongside so switching tabs never loses it. */
  image: ImageState
}

const NO_IMAGE: ImageState = { url: '', type: 'fill', position: 'center' }

/** `url("…")` / `url(…)` → the bare source, or null when it isn't one. */
export function parseImageUrl(value: string): string | null {
  const match = /^\s*url\(\s*([\s\S]*?)\s*\)\s*$/.exec(value)
  if (!match) return null
  return match[1].replace(/^["']|["']$/g, '')
}

export function initialFill(value: string, gradients: boolean, images = false): FillState {
  if (images) {
    const url = parseImageUrl(value)
    if (url !== null) {
      const hsva = rgbaToHsva(BLACK)
      return {
        mode: 'image',
        hsva,
        stops: defaultStops(hsva),
        angle: 180,
        image: { ...NO_IMAGE, url },
      }
    }
  }
  if (gradients) {
    const gradient = parseGradient(value)
    if (gradient) {
      const stops = gradient.stops.map((stop) => ({
        hsva: rgbaToHsva(stop.color),
        pos: stop.pos,
      }))
      return {
        mode: gradient.kind,
        hsva: stops[0].hsva,
        stops,
        angle: gradient.angle,
        image: NO_IMAGE,
      }
    }
  }
  const hsva = rgbaToHsva(parseColor(value) ?? BLACK)
  return { mode: 'solid', hsva, stops: defaultStops(hsva), angle: 180, image: NO_IMAGE }
}

/** Fresh gradient seed: the current colour fading to its transparent self. */
export function defaultStops(hsva: Hsva): StopState[] {
  return [
    { hsva, pos: 0 },
    { hsva: { ...hsva, a: 0 }, pos: 1 },
  ]
}

export function formatFill(fill: FillState, format: ColorFormat): string {
  if (fill.mode === 'image') return fill.image.url ? `url("${fill.image.url}")` : ''
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
