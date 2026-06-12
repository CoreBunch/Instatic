/**
 * Fonts — TypeBox schemas and derived types.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof T>`.
 * No parallel TypeScript interfaces — schema definitions ARE the contract.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@sinclair/typebox'
import { withFallback, filterArray } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import {
  normalizeFontTokenVariable,
  sanitizeFontFallbackStack,
} from './tokens'

// ---------------------------------------------------------------------------
// FontSource
// ---------------------------------------------------------------------------

const FontSourceSchema = Type.Union([
  Type.Literal('google'),
  Type.Literal('custom'),
])

type FontSource = Static<typeof FontSourceSchema>

// ---------------------------------------------------------------------------
// FontFileFormat
// ---------------------------------------------------------------------------

/**
 * Web-font container formats we can self-host + emit an `@font-face src` for.
 * Google installs are always `woff2`; custom uploads (and imported `@font-face`
 * sources) may be any of the four.
 */
const FontFileFormatSchema = Type.Union([
  Type.Literal('woff2'),
  Type.Literal('woff'),
  Type.Literal('ttf'),
  Type.Literal('otf'),
])

export type FontFileFormat = Static<typeof FontFileFormatSchema>

/** On-disk extension for each format — used for the path↔format consistency check. */
const EXTENSION_FOR_FONT_FORMAT: Record<FontFileFormat, string> = {
  woff2: '.woff2',
  woff: '.woff',
  ttf: '.ttf',
  otf: '.otf',
}

// ---------------------------------------------------------------------------
// FontFile
// ---------------------------------------------------------------------------

/**
 * Validate a font `src` path before it's interpolated into a `<style>` block.
 *
 * Two accepted shapes:
 *   - Self-hosted: a root-relative path under `/uploads/` (the Google installer
 *     writes to `/uploads/fonts/<slug>/`, custom + imported uploads land in the
 *     media library under `/uploads/media/`). Any of the four font extensions.
 *   - Media-backed external: an `https://` URL — accepted ONLY when the file
 *     carries a `mediaAssetId`, proving it came from our media pipeline on a
 *     deployment whose storage adapter serves assets off an external host.
 *     Arbitrary `https://` font URLs (no `mediaAssetId`) are rejected so a
 *     corrupted site document can't make the publisher fetch a third-party CDN.
 *
 * Always rejects traversal sequences and characters that could break out of a
 * CSS `url("...")` string or the surrounding `<style>` tag.
 */
function isSafeFontSrc(path: string, mediaAssetId?: string): boolean {
  if (!path || path.includes('..')) return false
  if (/["<>\\\s]/.test(path)) return false
  if (path.startsWith('/uploads/')) return true
  if (path.startsWith('https://')) return mediaAssetId != null && mediaAssetId.length > 0
  return false
}

/**
 * One font file backing an `@font-face` slice.
 *
 * `path` is the public URL the publisher emits inside `src: url("...")`. For
 * Google installs and self-hosted custom uploads it's a `/uploads/...` path;
 * for media-backed fonts on an external storage adapter it may be an `https://`
 * URL (gated by `mediaAssetId`, see `isSafeFontSrc`).
 *
 * Google's CSS2 endpoint emits multiple `@font-face` blocks per (variant ×
 * subset) request, each restricted to a different `unicode-range` slice. We
 * preserve every slice as its own `FontFile`. `unicodeRange` is optional;
 * custom uploads and imported faces typically have none.
 *
 * `mediaAssetId` is set for media-backed custom / imported fonts (so the entry
 * survives a storage-adapter migration and external URLs are trusted). Google
 * installs leave it unset.
 */
const FontFileSchema = Type.Object({
  variant: Type.String({ minLength: 1 }),
  subset: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  format: FontFileFormatSchema,
  unicodeRange: Type.Optional(Type.String({ minLength: 1 })),
  mediaAssetId: Type.Optional(Type.String({ minLength: 1 })),
})

export type FontFile = Static<typeof FontFileSchema>

/**
 * A self-hosted `/uploads/` path must carry the extension matching its declared
 * `format` (the media pipeline picks a server-trusted extension from the sniffed
 * MIME). External media URLs are exempt — a signed CDN URL may not end in `.woff2`.
 */
function fontPathMatchesFormat(file: FontFile): boolean {
  if (!file.path.startsWith('/uploads/')) return true
  const expected = EXTENSION_FOR_FONT_FORMAT[file.format]
  const pathname = file.path.split('?')[0]
  return pathname.toLowerCase().endsWith(expected)
}

/**
 * Allowed characters inside a `unicode-range:` value. The CSS spec accepts
 * `U+`, hex digits, dashes, commas, and whitespace. We forbid anything that
 * could break out of the declaration — the value is round-tripped verbatim
 * into a `<style>` block.
 */
const UNICODE_RANGE_PATTERN = /^[\sUu+0-9A-Fa-f,-]+$/

function isSafeUnicodeRange(range: string): boolean {
  return UNICODE_RANGE_PATTERN.test(range) && range.length <= 2048
}

// Composite check used by callers that want schema + path-safety in one go.
function checkFontFile(value: unknown): value is FontFile {
  if (!compiledCheck(FontFileSchema, value)) return false
  const file = value as FontFile
  if (!isSafeFontSrc(file.path, file.mediaAssetId)) return false
  if (!fontPathMatchesFormat(file)) return false
  if (file.unicodeRange != null && !isSafeUnicodeRange(file.unicodeRange)) {
    return false
  }
  return true
}

/** Re-exported so the CSS emitter applies the same path-safety rule at the
 *  `<style>` boundary that the schema applies at the storage boundary. */
export { isSafeFontSrc }

// ---------------------------------------------------------------------------
// FontEntry
// ---------------------------------------------------------------------------

/**
 * One font installed in the site library.
 * Invalid entries are silently dropped at the SiteFontsSettings level.
 */
export const FontEntrySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  source: withFallback(FontSourceSchema, 'google' as const),
  family: Type.String({ minLength: 1 }),
  variants: withFallback(Type.Array(Type.String({ minLength: 1 })), []),
  subsets: withFallback(Type.Array(Type.String({ minLength: 1 })), []),
  /** Invalid font-file entries are silently dropped. */
  files: Type.Array(FontFileSchema),
  category: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type FontEntry = Static<typeof FontEntrySchema>

/**
 * Tolerant parser: silently filters out invalid `files` entries and provides
 * timestamp fallbacks. Use this when reading persisted site documents where
 * one corrupt sub-entry should not invalidate the whole library.
 */
function parseFontEntry(raw: unknown): FontEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.family !== 'string' || r.family.length === 0) return null

  const source: FontSource = r.source === 'custom' ? 'custom' : 'google'
  const variants = Array.isArray(r.variants)
    ? r.variants.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  const subsets = Array.isArray(r.subsets)
    ? r.subsets.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  const files = Array.isArray(r.files) ? filterArray(FontFileSchema, r.files) : []
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()
  const category = typeof r.category === 'string' ? r.category : undefined

  return {
    id: r.id,
    source,
    family: r.family,
    variants,
    subsets,
    files: files.filter(checkFontFile),
    ...(category !== undefined ? { category } : {}),
    createdAt,
    updatedAt,
  }
}

// ---------------------------------------------------------------------------
// FontToken
// ---------------------------------------------------------------------------

const FontTokenSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  /** CSS custom-property slug without the leading dashes, e.g. `font-primary`. */
  variable: Type.String({ minLength: 1 }),
  /** Optional installed FontEntry id. Missing means fallback-only/system token. */
  familyId: Type.Optional(Type.String({ minLength: 1 })),
  fallback: Type.String({ minLength: 1 }),
  order: Type.Number(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type FontToken = Static<typeof FontTokenSchema>

function parseFontToken(raw: unknown): FontToken | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.name !== 'string' || r.name.trim().length === 0) return null
  if (typeof r.variable !== 'string' || r.variable.trim().length === 0) return null

  const variable = normalizeFontTokenVariable(r.variable)
  if (!variable) return null

  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()
  const order = typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0
  const fallback = sanitizeFontFallbackStack(typeof r.fallback === 'string' ? r.fallback : undefined)

  return {
    id: r.id,
    name: r.name.trim(),
    variable,
    ...(typeof r.familyId === 'string' && r.familyId.length > 0 ? { familyId: r.familyId } : {}),
    fallback,
    order,
    createdAt,
    updatedAt,
  }
}

// ---------------------------------------------------------------------------
// SiteFontsSettings
// ---------------------------------------------------------------------------

/** Library of installed fonts for a site. */
export const SiteFontsSettingsSchema = Type.Object({
  items: Type.Array(FontEntrySchema),
  tokens: Type.Optional(Type.Array(FontTokenSchema)),
})

export type SiteFontsSettings = Static<typeof SiteFontsSettingsSchema>

/**
 * Tolerant parser used by site-document loaders. Drops any malformed entries
 * rather than failing the whole site validation.
 */
export function parseSiteFontsSettings(raw: unknown): SiteFontsSettings {
  if (!raw || typeof raw !== 'object') return { items: [] }
  const items = (raw as { items?: unknown }).items
  const tokens = (raw as { tokens?: unknown }).tokens
  if (!Array.isArray(items)) return { items: [] }
  const parsedTokens: FontToken[] = []
  const seenTokenIds = new Set<string>()
  const seenVariables = new Set<string>()
  if (Array.isArray(tokens)) {
    for (const item of tokens) {
      const parsed = parseFontToken(item)
      if (!parsed) continue
      if (seenTokenIds.has(parsed.id)) continue
      if (seenVariables.has(parsed.variable)) continue
      seenTokenIds.add(parsed.id)
      seenVariables.add(parsed.variable)
      parsedTokens.push(parsed)
    }
  }
  return {
    items: items.flatMap((item) => {
      const parsed = parseFontEntry(item)
      return parsed ? [parsed] : []
    }),
    ...(parsedTokens.length > 0 ? { tokens: parsedTokens } : {}),
  }
}
