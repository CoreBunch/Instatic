/**
 * effectsModel — the Effects section's task-shaped view of three CSS
 * properties (docs/features/inspector-panel.md §6.5).
 *
 * The prototype lists EFFECTS, not declarations: "Drop shadow", "Inner
 * shadow", "Layer blur", "Background blur". Underneath they are ordinary CSS:
 *
 *   Drop shadow / Inner shadow → one entry of the `box-shadow` list
 *   Layer blur                 → `blur()` inside `filter`
 *   Background blur            → `blur()` inside `backdrop-filter`
 *
 * So this module is the translation both ways, and nothing else: no React, no
 * store. Two rules it exists to keep:
 *
 *  - **A property is never rewritten wholesale.** `filter` may carry
 *    `grayscale()` the panel has no row for; setting the blur must leave it
 *    standing. Same for the other entries of a `box-shadow` list.
 *  - **Round-tripping is lossless for values we understand.** Parsing then
 *    formatting an untouched shadow returns the same declaration, so opening
 *    a popout and closing it cannot silently rewrite the user's CSS.
 */

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

/**
 * Split on separators that are NOT inside parentheses, so `rgba(0, 0, 0, .3)`
 * survives a comma split and `blur(4px) drop-shadow(0 1px 2px)` survives a
 * space split.
 */
function splitTopLevel(value: string, separator: ',' | ' '): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    const isSeparator = depth === 0 && (separator === ',' ? char === ',' : /\s/.test(char))
    if (isSeparator) {
      if (current.trim() !== '') parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** A CSS length/number — everything else in a shadow is the colour. */
function isLength(token: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([a-z%]*)$/i.test(token)
}

const NONE_VALUES = new Set(['', 'none', 'initial', 'unset', 'revert'])

export function parseShadowList(value: unknown): ShadowEffect[] {
  if (typeof value !== 'string' || NONE_VALUES.has(value.trim().toLowerCase())) return []
  return splitTopLevel(value, ',')
    .map(parseShadow)
    .filter((shadow): shadow is ShadowEffect => shadow !== null)
}

function parseShadow(declaration: string): ShadowEffect | null {
  const tokens = splitTopLevel(declaration, ' ')
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
  if (lengths.length < 2) return null

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

export function formatShadowList(list: ReadonlyArray<ShadowEffect>): string | undefined {
  if (list.length === 0) return undefined
  return list.map(formatShadow).join(', ')
}

/** Leading value shown on the row: `0 4 · 4px`, the prototype's summary. */
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
  const match = /(?:^|\s)blur\(([^)]*)\)/i.exec(value)
  return match ? match[1].trim() : null
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
  const others = splitTopLevel(source, ' ').filter((fn) => !/^blur\(/i.test(fn))
  const list = next === null || next.trim() === ''
    ? others
    : [`blur(${next.trim()})`, ...others]
  return list.length > 0 ? list.join(' ') : undefined
}

// ---------------------------------------------------------------------------
// The catalogue: which named effects exist, and what the element carries now
// ---------------------------------------------------------------------------

/** Effects with a clean CSS counterpart, in the prototype's catalogue order. */
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
  parseShadowList(styles.boxShadow).forEach((shadow, shadowIndex) => {
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
