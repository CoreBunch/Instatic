/** Translate inspector effects to CSS while preserving sibling shadows and filter functions. */

import { splitCssList } from '@ui/lib/cssValueList'

export interface ShadowEffect {
  /** `inset` keyword — the difference between a drop and an inner shadow. */
  inset: boolean
  x: string
  y: string
  blur: string
  spread: string
  /** Empty when the declaration omitted the colour (CSS then uses currentColor). */
  color: string
}

/** A CSS length/number — everything else in a shadow is the colour. */
function isLength(token: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]*)$/i.test(token)
}

const NONE_VALUES = new Set(['', 'none', 'initial', 'inherit', 'unset', 'revert', 'revert-layer'])

export function hasCustomShadow(value: unknown): boolean {
  return typeof value === 'string' && splitCssList(value, ',').some((layer) => !parseShadow(layer))
}

function parseShadow(declaration: string): ShadowEffect | null {
  const tokens = splitCssList(declaration, ' ')
  if (tokens.length === 0) return null

  const inset = tokens.some((token) => token.toLowerCase() === 'inset')
  const rest = tokens.filter((token) => token.toLowerCase() !== 'inset')
  const lengths = rest.filter(isLength)
  // Anything that is not a length is the colour. Keeping it verbatim means a
  // `var(--brand)` shadow round-trips as `var(--brand)`, not as its resolved
  // hex, which would freeze the token into a literal.
  const color = rest.find((token) => !isLength(token)) ?? ''

  // x and y are required by CSS; without them this is not a shadow we can
  // edit, so the row leaves the declaration alone (the raw field still shows).
  if (/^(calc|min|max|clamp)\(/i.test(color)) return null
  if (lengths.length < 2 || lengths.length > 4 || rest.length - lengths.length > 1) return null

  return {
    inset,
    x: lengths[0],
    y: lengths[1],
    blur: lengths[2] ?? '0',
    spread: lengths[3] ?? '0',
    color,
  }
}

export function formatShadow(shadow: ShadowEffect): string {
  const parts = [shadow.x, shadow.y, shadow.blur, shadow.spread]
  if (shadow.color !== '') parts.push(shadow.color)
  if (shadow.inset) parts.unshift('inset')
  return parts.join(' ')
}

/** Replace only the edited layer, retaining unrecognised and token-based shadows verbatim. */
export function changeShadow(value: unknown, index: number | null, next: ShadowEffect | null): string | undefined {
  const layers = typeof value === 'string' && !NONE_VALUES.has(value.trim().toLowerCase())
    ? splitCssList(value, ',') : []
  if (index === null && next) layers.push(formatShadow(next))
  else if (index !== null) layers.splice(index, 1, ...(next ? [formatShadow(next)] : []))
  return layers.join(', ') || undefined
}

/** Leading value shown on the row: `0 4 · 4px`, as shown in the inspector. */
export function shadowSummary(shadow: ShadowEffect): string {
  return `${stripUnit(shadow.x)} ${stripUnit(shadow.y)} · ${shadow.blur}`
}

function stripUnit(length: string): string {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:px)?$/i.exec(length)
  return match ? match[1] : length
}

// ---------------------------------------------------------------------------
// filter / backdrop-filter — one function inside a list of functions
// ---------------------------------------------------------------------------

/** The `blur()` argument, or null when the list has no blur. */
export function readBlur(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const fn = splitCssList(value, ' ').find((part) => /^blur\(/i.test(part))
  return fn?.slice(5, -1).trim() ?? null
}

/**
 * Write (or drop) `blur()` while leaving every other filter function in place
 * and in order. Returns `undefined` when nothing is left — the caller then
 * clears the property instead of storing `""`.
 */
export function writeBlur(value: unknown, next: string | null): string | undefined {
  const source = typeof value === 'string' && !NONE_VALUES.has(value.trim().toLowerCase())
    ? value
    : ''
  const list = splitCssList(source, ' ')
  const index = list.findIndex((fn) => /^blur\(/i.test(fn))
  const replacement = next && next.trim() ? [`blur(${next.trim()})`] : []
  list.splice(index < 0 ? 0 : index, index < 0 ? 0 : 1, ...replacement)
  return list.length > 0 ? list.join(' ') : undefined
}

// ---------------------------------------------------------------------------
// The catalogue: which named effects exist, and what the element carries now
// ---------------------------------------------------------------------------

/** Effects with a clean CSS counterpart, in menu order. */
export const EFFECT_KINDS = [
  'dropShadow',
  'innerShadow',
  'layerBlur',
  'backgroundBlur',
] as const

export type EffectKind = (typeof EFFECT_KINDS)[number]

export const EFFECT_LABELS: Record<EffectKind, string> = {
  dropShadow: 'Drop shadow',
  innerShadow: 'Inner shadow',
  layerBlur: 'Layer blur',
  backgroundBlur: 'Background blur',
}

/** Starter values for a freshly added effect — visible, and easy to nudge. */
export const NEW_SHADOW: ShadowEffect = {
  inset: false,
  x: '0',
  y: '4px',
  blur: '4px',
  spread: '0',
  color: 'rgba(0, 0, 0, 0.25)',
}
export const NEW_BLUR = '4px'

/** One live effect on the element, ready to render as a row. */
export interface EffectEntry {
  kind: EffectKind
  summary: string
  /** Index into the box-shadow list; absent for the blur effects. */
  shadowIndex?: number
  shadow?: ShadowEffect
  blur?: string
}

/**
 * Read the element's effects out of the three properties that carry them.
 * Both menus and rows read through this, so "already used" and "shown as a
 * row" can never disagree.
 */
export function readEffects(styles: Record<string, unknown>): EffectEntry[] {
  const entries: EffectEntry[] = []
  splitCssList(String(styles.boxShadow ?? ''), ',').forEach((layer, shadowIndex) => {
    const shadow = parseShadow(layer)
    if (!shadow) return
    entries.push({
      kind: shadow.inset ? 'innerShadow' : 'dropShadow',
      summary: shadowSummary(shadow),
      shadowIndex,
      shadow,
    })
  })
  const layer = readBlur(styles.filter)
  if (layer !== null) entries.push({ kind: 'layerBlur', summary: layer, blur: layer })
  const backdrop = readBlur(styles.backdropFilter)
  if (backdrop !== null) {
    entries.push({ kind: 'backgroundBlur', summary: backdrop, blur: backdrop })
  }
  return entries
}
