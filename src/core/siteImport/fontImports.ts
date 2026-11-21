import { compareVariants, findGoogleFont, parseVariant } from '@core/fonts'
import type { GoogleFontFamily } from '@core/fonts'
import type { GoogleFontRequest } from './types'

const GOOGLE_FONT_STYLESHEET_HOST = 'fonts.googleapis.com'
const CSS2_PATH = '/css2'
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)[^;]*;/gi
const CSS_COMMENT_RE = /\/\*[\s\S]*?\*\//g

function parseGoogleCss2Url(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'https:') return null
    if (parsed.hostname.toLowerCase() !== GOOGLE_FONT_STYLESHEET_HOST) return null
    if (parsed.pathname !== CSS2_PATH) return null
    return parsed
  } catch {
    return null
  }
}

function defaultVariantFor(entry: GoogleFontFamily): string[] {
  if (entry.variants.includes('400')) return ['400']
  return entry.variants.length > 0 ? [[...entry.variants].sort(compareVariants)[0]] : []
}

function requestedSubsets(url: URL, entry: GoogleFontFamily): string[] {
  const requested = url.searchParams
    .getAll('subset')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  const allowed = new Set(entry.subsets)
  const resolved = requested.filter((subset) => allowed.has(subset))
  if (resolved.length > 0) return [...new Set(resolved)]
  if (allowed.has('latin')) return ['latin']
  return entry.subsets[0] ? [entry.subsets[0]] : []
}

function parseWeightExpression(expr: string): { min: number; max: number } | null {
  const trimmed = expr.trim()
  const range = /^(\d+)\.\.(\d+)$/.exec(trimmed)
  if (range) {
    const min = Number(range[1])
    const max = Number(range[2])
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null
  }
  const weight = Number(trimmed)
  return Number.isFinite(weight) ? { min: weight, max: weight } : null
}

function variantsForAxisSpec(axisSpec: string | undefined, entry: GoogleFontFamily): string[] {
  if (!axisSpec) return defaultVariantFor(entry)

  const [axesRaw, valuesRaw] = axisSpec.split('@')
  if (!axesRaw || !valuesRaw) return defaultVariantFor(entry)

  const axes = axesRaw.split(',').map((axis) => axis.trim())
  const italicIndex = axes.indexOf('ital')
  const weightIndex = axes.indexOf('wght')
  const allowed = entry.variants
    .map((variant) => ({ variant, parsed: parseVariant(variant) }))
    .filter((item): item is { variant: string; parsed: NonNullable<ReturnType<typeof parseVariant>> } => item.parsed !== null)
  const selected = new Set<string>()

  for (const row of valuesRaw.split(';')) {
    const values = row.split(',').map((value) => value.trim())
    const italic =
      italicIndex >= 0
        ? values[italicIndex] === '1'
        : false
    const weightRange =
      weightIndex >= 0
        ? parseWeightExpression(values[weightIndex] ?? '')
        : parseWeightExpression('400')
    if (!weightRange) continue

    for (const { variant, parsed } of allowed) {
      if (parsed.italic !== italic) continue
      if (parsed.weight < weightRange.min || parsed.weight > weightRange.max) continue
      selected.add(variant)
    }
  }

  const variants = [...selected].sort(compareVariants)
  return variants.length > 0 ? variants : defaultVariantFor(entry)
}

function parseFamilySpec(spec: string, url: URL): GoogleFontRequest | null {
  const colon = spec.indexOf(':')
  const family = (colon >= 0 ? spec.slice(0, colon) : spec).trim()
  const axisSpec = colon >= 0 ? spec.slice(colon + 1).trim() : undefined
  const entry = findGoogleFont(family)
  if (!entry) return null

  const variants = variantsForAxisSpec(axisSpec, entry)
  const subsets = requestedSubsets(url, entry)
  if (variants.length === 0 || subsets.length === 0) return null
  return { family: entry.family, variants, subsets }
}

function mergeGoogleFont(
  byFamily: Map<string, GoogleFontRequest>,
  font: GoogleFontRequest,
): void {
  const key = font.family.toLowerCase()
  const existing = byFamily.get(key)
  if (!existing) {
    byFamily.set(key, font)
    return
  }
  existing.variants = [...new Set([...existing.variants, ...font.variants])].sort(compareVariants)
  existing.subsets = [...new Set([...existing.subsets, ...font.subsets])]
}

/**
 * Extract trusted Google Fonts CSS2 @import rules as install requests.
 *
 * The importer does not persist third-party stylesheets. Google CSS2 imports
 * are translated into the same self-hosted install requests the Typography
 * panel uses, so imported font-family stacks work in the editor and publisher
 * through `site.settings.fonts.items`.
 */
/**
 * Harvests the Google-font `@import` requests of one CSS source before they
 * are stripped. `stylesheetPath` is the stylesheet file the source belongs to
 * (`ImportStylesheet.path`), or `null` for CSS converted into style rules.
 */
export type GoogleFontCollector = (cssSource: string, stylesheetPath: string | null) => void

export function extractGoogleFontImports(cssSource: string): GoogleFontRequest[] {
  const byFamily = new Map<string, GoogleFontRequest>()
  const sourceWithoutComments = cssSource.replace(CSS_COMMENT_RE, '')

  for (const match of sourceWithoutComments.matchAll(CSS_IMPORT_RE)) {
    const rawUrl = (match[2] ?? match[4] ?? '').trim()
    const url = parseGoogleCss2Url(rawUrl)
    if (!url) continue
    for (const spec of url.searchParams.getAll('family')) {
      const font = parseFamilySpec(spec, url)
      if (font) mergeGoogleFont(byFamily, font)
    }
  }

  return [...byFamily.values()]
}

export function stripGoogleFontImportRules(cssSource: string): string {
  return cssSource.replace(CSS_IMPORT_RE, (source, _q1, rawUrl1, _q2, rawUrl2) => {
    const rawUrl = String(rawUrl1 ?? rawUrl2 ?? '').trim()
    return parseGoogleCss2Url(rawUrl) ? '' : source
  })
}
