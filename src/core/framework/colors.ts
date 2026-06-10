import type { StyleRule, CSSPropertyBag } from '@core/page-tree'
import { classKindSelector } from '@core/page-tree'
import type {
  FrameworkColorSettings,
  FrameworkColorToken,
  FrameworkColorUtilityType,
} from '@core/framework-schema'
import { formatCssVariableBlock } from './cssVariables'

export type {
  FrameworkColorSettings,
  FrameworkColorUtilityType,
} from '@core/framework-schema'

export interface FrameworkColorVariable {
  name: string
  value: string
  tokenId: string
  slug: string
  variantId: string
  variantName?: string
}

export interface FrameworkColorVariableSets {
  light: FrameworkColorVariable[]
  dark: FrameworkColorVariable[]
}

/**
 * The two parallel color outputs derived from one shared, ordered token
 * enumeration: the `:root` variable sets and the locked utility classes.
 * Building both from a single `planColorTokens` pass means the ordered-sort,
 * slug-dedup, and variant-expansion run once per generation instead of twice.
 */
export interface FrameworkColorPlan {
  variableSets: FrameworkColorVariableSets
  utilityClasses: Record<string, StyleRule>
}

/** A token paired with its deduped slug and expanded variants — built once. */
interface ColorTokenPlan {
  token: FrameworkColorToken
  slug: string
  variants: FrameworkColorVariant[]
}

interface ColorChannels {
  h: number
  s: number
  l: number
  a: number
}

interface FrameworkColorVariant {
  id: string
  suffix: string
  variantName?: string
  variableName: (slug: string) => string
  /** Returns the resolved CSS value, or null when the base color can't be parsed. */
  value: (base: string) => string | null
}

const TRANSPARENT_STEPS = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90] as const
const UTILITY_ORDER: FrameworkColorUtilityType[] = ['text', 'background', 'border', 'fill']
const HSLA_RE = /^hsla?\(\s*([-+]?\d*\.?\d+)(?:deg)?\s*,\s*([-+]?\d*\.?\d+)%\s*,\s*([-+]?\d*\.?\d+)%(?:\s*,\s*([-+]?\d*\.?\d+))?\s*\)$/i
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
// rgb()/rgba(), both comma and space syntax, alpha as number or percentage.
const RGBA_RE = /^rgba?\(\s*(\d*\.?\d+)\s*[, ]\s*(\d*\.?\d+)\s*[, ]\s*(\d*\.?\d+)\s*(?:[,/]\s*(\d*\.?\d+%?))?\s*\)$/i

export function normalizeFrameworkColorSlug(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/^--+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'color'
}

/**
 * Plan the ordered token enumeration once: sort tokens, dedup their slugs, and
 * expand each token's variants. Both the variable-sets and utility-class passes
 * consume this so the work is not duplicated.
 */
function planColorTokens(
  settings: FrameworkColorSettings | null | undefined,
): ColorTokenPlan[] {
  if (!settings) return []
  const tokens = orderedTokens(settings)
  const slugById = buildColorSlugMap(tokens)
  return tokens.map((token) => ({
    token,
    slug: slugById.get(token.id)!,
    variants: buildColorVariants(token),
  }))
}

/**
 * Build the per-generation `tokenId → CSS-var slug` map.
 *
 * `normalizeFrameworkColorSlug` can map two distinct token slugs to the same
 * root (e.g. "Primary Color" and "Primary_Color" → "primary-color"). Computing
 * it per-token in each loop let the second token silently shadow the first in
 * the emitted `:root {}` block. We instead resolve every slug once, in
 * generation (ordered) order, so the first token keeps the base slug and each
 * later collision is disambiguated with a `-2`, `-3`, … suffix.
 */
function buildColorSlugMap(tokens: FrameworkColorToken[]): Map<string, string> {
  const used = new Set<string>()
  const slugById = new Map<string, string>()
  for (const token of tokens) {
    const base = normalizeFrameworkColorSlug(token.slug)
    let slug = base
    let suffix = 2
    while (used.has(slug)) {
      slug = `${base}-${suffix}`
      suffix += 1
    }
    used.add(slug)
    slugById.set(token.id, slug)
  }
  return slugById
}

function colorVariableSetsFromPlan(plan: ColorTokenPlan[]): FrameworkColorVariableSets {
  const light: FrameworkColorVariable[] = []
  const dark: FrameworkColorVariable[] = []

  for (const { token, slug, variants } of plan) {
    for (const variant of variants) {
      // A derived variant (transparent/shade/tint) of an unparseable color
      // yields null and emits no variable; the base variant falls back to the
      // authored value (sanitised at emission by `formatCssVariableBlock`).
      const lightVariable = toVariable(token, slug, variant, token.lightValue)
      if (lightVariable) light.push(lightVariable)
      if (token.darkModeEnabled) {
        const darkVariable = toVariable(token, slug, variant, token.darkValue)
        if (darkVariable) dark.push(darkVariable)
      }
    }
  }

  return { light, dark }
}

export function generateFrameworkColorVariableSets(
  settings: FrameworkColorSettings | null | undefined,
): FrameworkColorVariableSets {
  return colorVariableSetsFromPlan(planColorTokens(settings))
}

/**
 * Derive both color outputs from a single ordered enumeration. Used by the
 * publisher's `buildFrameworkPlan` and the agent's `describeFrameworkTokens`,
 * which both need the variable sets and the utility classes paired up.
 */
export function generateFrameworkColorPlan(
  settings: FrameworkColorSettings | null | undefined,
): FrameworkColorPlan {
  const plan = planColorTokens(settings)
  return {
    variableSets: colorVariableSetsFromPlan(plan),
    utilityClasses: colorUtilityClassesFromPlan(plan),
  }
}

export function formatFrameworkColorThemeCss(sets: FrameworkColorVariableSets): string {
  if (sets.dark.length === 0) return ''

  return [
    sets.light.length > 0
      ? formatCssVariableBlock(DEFAULT_THEME_OVERRIDE_SELECTOR, sets.light)
      : '',
    formatCssVariableBlock(ALT_THEME_SELECTOR, sets.dark),
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function generateDefaultDarkColor(lightValue: string): string {
  // Best-effort default for the stored `darkValue` field (a string). When the
  // light color can't be parsed there's no meaningful shade, so fall back to the
  // trimmed light value — emission re-validates it through the sanitiser anyway.
  return shiftLightness(lightValue, 1, 1, 'shade') ?? lightValue.trim()
}

export function generateFrameworkColorUtilityClasses(
  settings: FrameworkColorSettings | null | undefined,
): Record<string, StyleRule> {
  return colorUtilityClassesFromPlan(planColorTokens(settings))
}

function colorUtilityClassesFromPlan(plan: ColorTokenPlan[]): Record<string, StyleRule> {
  const classes: Record<string, StyleRule> = {}

  for (const { token, slug, variants } of plan) {
    for (const variant of variants) {
      const tokenName = variant.suffix ? `${slug}-${variant.suffix}` : slug
      const variableRef = `var(${variant.variableName(slug)})`
      for (const utility of UTILITY_ORDER) {
        if (!token.generateUtilities[utility]) continue
        const id = frameworkColorClassId(token.id, variant.id, utility)
        const now = token.updatedAt || token.createdAt || 0
        const name = utilityClassName(utility, tokenName)
        classes[id] = {
          id,
          name,
          kind: 'class',
          selector: classKindSelector(name),
          order: 0,
          styles: utilityStyles(utility, variableRef),
          contextStyles: {},
          generated: {
            origin: 'framework',
            family: 'color',
            sourceId: token.id,
            utility,
            tokenName: slug,
            variantName: variant.variantName,
            locked: true,
          },
          tags: ['framework', 'utility', 'color'],
          createdAt: token.createdAt || now,
          updatedAt: now,
        }
      }
    }
  }

  return classes
}

export function frameworkColorClassId(
  tokenId: string,
  variantId: string,
  utility: FrameworkColorUtilityType,
): string {
  return `framework:color:${tokenId}:${variantId}:${utility}`
}

function orderedTokens(settings: FrameworkColorSettings): FrameworkColorToken[] {
  return [...settings.tokens].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
}

function toVariable(
  token: FrameworkColorToken,
  slug: string,
  variant: FrameworkColorVariant,
  baseValue: string,
): FrameworkColorVariable | null {
  const value = variant.value(baseValue)
  if (value === null) return null
  return {
    name: variant.variableName(slug),
    value,
    tokenId: token.id,
    slug,
    variantId: variant.id,
    variantName: variant.variantName,
  }
}

function buildColorVariants(token: FrameworkColorToken): FrameworkColorVariant[] {
  const variants: FrameworkColorVariant[] = [
    {
      id: 'base',
      suffix: '',
      variableName: (slug) => `--${slug}`,
      // The base variable must always emit: an unparseable-but-authored value
      // (oklch(), color-mix(), named color) passes through verbatim so every
      // `var(--<slug>)` reference keeps resolving. Derived variants below
      // still skip when the value can't be modelled.
      value: (base) => normalizeColorValue(base) ?? verbatimColorValue(base),
    },
  ]

  if (token.generateTransparent) {
    for (const step of TRANSPARENT_STEPS) {
      variants.push({
        id: `transparent-${step}`,
        suffix: String(step),
        variantName: String(step),
        variableName: (slug) => `--${slug}-${step}`,
        value: (base) => withAlpha(base, step / 100),
      })
    }
  }

  if (token.generateShades.enabled) {
    const count = clampVariantCount(token.generateShades.count)
    for (let index = 1; index <= count; index += 1) {
      variants.push({
        id: `shade-${index}`,
        suffix: `d-${index}`,
        variantName: `d-${index}`,
        variableName: (slug) => `--${slug}-d-${index}`,
        value: (base) => shiftLightness(base, index, count, 'shade'),
      })
    }
  }

  if (token.generateTints.enabled) {
    const count = clampVariantCount(token.generateTints.count)
    for (let index = 1; index <= count; index += 1) {
      variants.push({
        id: `tint-${index}`,
        suffix: `l-${index}`,
        variantName: `l-${index}`,
        variableName: (slug) => `--${slug}-l-${index}`,
        value: (base) => shiftLightness(base, index, count, 'tint'),
      })
    }
  }

  return variants
}

function clampVariantCount(count: number): number {
  return Math.max(0, Math.min(12, Math.floor(count)))
}

function utilityClassName(utility: FrameworkColorUtilityType, tokenName: string): string {
  switch (utility) {
    case 'text':
      return `text-${tokenName}`
    case 'background':
      return `bg-${tokenName}`
    case 'border':
      return `border-${tokenName}`
    case 'fill':
      return `fill-${tokenName}`
  }
}

function utilityStyles(
  utility: FrameworkColorUtilityType,
  value: string,
): Partial<CSSPropertyBag> {
  switch (utility) {
    case 'text':
      return { color: value }
    case 'background':
      return { backgroundColor: value }
    case 'border':
      return { borderColor: value }
    case 'fill':
      return { fill: value }
  }
}

// All three color transforms validate at the boundary: they return null for any
// value `parseColor` can't understand (anything that isn't hex, rgb/rgba, or
// hsl/hsla — e.g. oklch()/named/color-mix). Derived variants (transparent
// steps, shades, tints) skip null — there is no meaningful way to derive them.
// The BASE variable instead falls back to the authored value verbatim (see
// `buildColorVariants`): a token the engine can't model must still emit its
// `--<slug>`, or every `var(--<slug>)` reference in imported CSS silently
// loses its declaration. Emission is injection-safe either way —
// `formatCssVariableBlock` runs every value through `sanitiseCssValue`.
function normalizeColorValue(value: string): string | null {
  const channels = parseColor(value)
  return channels ? formatHsla(channels) : null
}

/**
 * Verbatim fallback for base variables whose value `parseColor` can't model
 * (oklch(), color-mix(), named colors, …). Returns the trimmed authored value,
 * or null for empty input.
 */
function verbatimColorValue(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function withAlpha(value: string, alpha: number): string | null {
  const channels = parseColor(value)
  if (!channels) return null
  return formatHsla({ ...channels, a: alpha })
}

function shiftLightness(
  value: string,
  index: number,
  count: number,
  mode: 'shade' | 'tint',
): string | null {
  const channels = parseColor(value)
  if (!channels) return null
  const ratio = index / (count + 1)
  const nextLightness = mode === 'shade'
    ? channels.l * (1 - ratio * 0.8)
    : channels.l + (100 - channels.l) * ratio * 0.8
  return formatHsla({ ...channels, l: nextLightness })
}

function parseColor(value: string): ColorChannels | null {
  const input = value.trim()
  const hslaMatch = input.match(HSLA_RE)
  if (hslaMatch) {
    return {
      h: normalizeHue(Number(hslaMatch[1])),
      s: clamp(Number(hslaMatch[2]), 0, 100),
      l: clamp(Number(hslaMatch[3]), 0, 100),
      a: hslaMatch[4] === undefined ? 1 : clamp(Number(hslaMatch[4]), 0, 1),
    }
  }

  const hexMatch = input.match(HEX_RE)
  if (hexMatch) {
    return rgbToHsl(...hexToRgb(hexMatch[1]))
  }

  const rgbaMatch = input.match(RGBA_RE)
  if (rgbaMatch) {
    const alphaRaw = rgbaMatch[4]
    const alpha = alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith('%')
        ? clamp(Number(alphaRaw.slice(0, -1)) / 100, 0, 1)
        : clamp(Number(alphaRaw), 0, 1)
    return {
      ...rgbToHsl(
        clamp(Number(rgbaMatch[1]), 0, 255),
        clamp(Number(rgbaMatch[2]), 0, 255),
        clamp(Number(rgbaMatch[3]), 0, 255),
      ),
      a: alpha,
    }
  }

  return null
}

function hexToRgb(hex: string): [number, number, number] {
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16)
    const g = parseInt(hex[1] + hex[1], 16)
    const b = parseInt(hex[2] + hex[2], 16)
    return [r, g, b]
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

function rgbToHsl(r: number, g: number, b: number): ColorChannels {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) {
    return { h: 0, s: 0, l: l * 100, a: 1 }
  }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === rn
      ? (gn - bn) / d + (gn < bn ? 6 : 0)
      : max === gn
        ? (bn - rn) / d + 2
        : (rn - gn) / d + 4
  return { h: h * 60, s: s * 100, l: l * 100, a: 1 }
}

function formatHsla({ h, s, l, a }: ColorChannels): string {
  return `hsla(${formatNumber(normalizeHue(h))}, ${formatNumber(clamp(s, 0, 100))}%, ${formatNumber(clamp(l, 0, 100))}%, ${formatNumber(clamp(a, 0, 1))})`
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const DEFAULT_THEME_OVERRIDE_SELECTOR = [
  ':root.theme-alt .theme-inverted',
  ':root.theme-alt .theme-always-default',
  ':root.theme-default .theme-inverted .theme-always-default',
].join(',\n')

const ALT_THEME_SELECTOR = [
  ':root.theme-alt',
  ':root.theme-default .theme-inverted',
  ':root.theme-default .theme-always-alt',
  ':root.theme-alt .theme-inverted .theme-always-alt',
].join(',\n')
