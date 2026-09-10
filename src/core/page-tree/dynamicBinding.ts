/**
 * DynamicPropBinding — CMS template overlay for a node prop.
 *
 * Source semantics:
 * - `currentEntry` — top of the publisher's entry stack. Inside a `base.loop`
 *   subtree this is the iteration's item; outside any loop on a single-entry
 *   template page this is the entry being viewed.
 * - `parentEntry` — one frame below the top. Inside a loop nested in a
 *   single-entry template, this lets a node refer to the outer template
 *   entry (e.g. "Related to {parentEntry.title}").
 * - `page` — fields of the page being rendered (title, slug, permalink, …).
 *   Always present on every render — no loop or template needed.
 * - `site` — site-level fields (name, baseUrl, settings.*). Always present.
 * - `route` — URL frame (path, slug, segments). Always present.
 *
 * Format tag controls how the resolved value is rendered (plain text, raw
 * HTML, URL, media path). Fallback strategy controls behaviour when the
 * binding resolves to empty.
 *
 * Structured bindings are stored as a prop-keyed overlay. String props can also
 * contain inline `{source.field}` tokens; both forms resolve at render time.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import { asPlainObject } from './parseHelpers'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const DynamicBindingSourceSchema = Type.Union([
  Type.Literal('currentEntry'),
  Type.Literal('parentEntry'),
  Type.Literal('page'),
  Type.Literal('site'),
  Type.Literal('route'),
])
type DynamicBindingSource = Static<typeof DynamicBindingSourceSchema>

const DynamicBindingFormatSchema = Type.Union([
  Type.Literal('plain'),
  Type.Literal('html'),
  Type.Literal('url'),
  Type.Literal('media'),
])
type DynamicBindingFormat = Static<typeof DynamicBindingFormatSchema>

export const DynamicPropBindingSchema = Type.Object({
  source: DynamicBindingSourceSchema,
  field: Type.String({ minLength: 1 }),
  /** Valid format tag; silently dropped if unrecognised or absent — handled in parseDynamicPropBinding. */
  format: Type.Optional(DynamicBindingFormatSchema),
  /** Fallback strategy; silently dropped if unrecognised or absent — handled in parseDynamicPropBinding. */
  fallback: Type.Optional(Type.Union([Type.Literal('static'), Type.Literal('empty')])),
})

export type DynamicPropBinding = Static<typeof DynamicPropBindingSchema>

// ---------------------------------------------------------------------------
// VisibilityCondition
// ---------------------------------------------------------------------------

/**
 * Show or hide a node based on the data it is rendered against.
 *
 * `hidden` on the node is the author's own switch and never changes; this is
 * the per-render one. Both are checked in the same place, and either one
 * hiding a node removes it and its subtree from the output.
 *
 * The point is a list whose items are not uniform. Two nodes sit in one card —
 * a video player and a "Coming soon" caption — and exactly one belongs on any
 * given row, decided by whether that row's video field is filled. Without this
 * the card can only be built one way, so every row gets a player (blank for the
 * rows with no video) or every row gets the caption.
 *
 * `isSet` is true when the field resolves to something a reader would see: a
 * non-blank string, a non-empty list, any number including zero, `true`. It is
 * false for absent, null, `""`, whitespace, `[]`, `{}` and `false` — an unset
 * checkbox reads as unset, which is what an author picking "is set" means.
 *
 * The source is the same set the prop bindings use, so `currentEntry` inside a
 * loop is that iteration's row and `page` / `site` / `route` work on any page.
 * Deliberately only two tests: comparisons against a value need an operand and
 * a type model, and every case met so far is "does this row have one".
 */
export const VisibilityConditionSchema = Type.Object({
  source: DynamicBindingSourceSchema,
  field: Type.String({ minLength: 1 }),
  test: Type.Union([Type.Literal('isSet'), Type.Literal('isNotSet')]),
})

export type VisibilityCondition = Static<typeof VisibilityConditionSchema>

/** Parse a VisibilityCondition; anything malformed becomes `undefined`. */
export function parseVisibilityCondition(raw: unknown): VisibilityCondition | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const VALID_SOURCES: DynamicBindingSource[] = ['currentEntry', 'parentEntry', 'page', 'site', 'route']
  if (!VALID_SOURCES.includes(r.source as DynamicBindingSource)) return undefined
  if (typeof r.field !== 'string' || r.field.length === 0) return undefined
  if (r.test !== 'isSet' && r.test !== 'isNotSet') return undefined
  return { source: r.source as DynamicBindingSource, field: r.field, test: r.test }
}

/**
 * Does this value count as "set"?
 *
 * Exported because the publisher and the editor canvas must agree exactly —
 * a node that vanishes on the published page while staying put on the canvas
 * is worse than either behaviour alone.
 */
export function isValueSet(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value as object).length > 0
  return true
}

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

/** Parse a DynamicPropBinding, silently dropping unrecognised format/fallback values. */
function parseDynamicPropBinding(raw: unknown): DynamicPropBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const VALID_SOURCES: DynamicBindingSource[] = [
    'currentEntry',
    'parentEntry',
    'page',
    'site',
    'route',
  ]
  if (!VALID_SOURCES.includes(r.source as DynamicBindingSource)) return null
  if (typeof r.field !== 'string' || r.field.length === 0) return null

  const VALID_FORMATS: DynamicBindingFormat[] = ['plain', 'html', 'url', 'media']
  const format: DynamicBindingFormat | undefined = VALID_FORMATS.includes(r.format as DynamicBindingFormat)
    ? (r.format as DynamicBindingFormat)
    : undefined

  const VALID_FALLBACKS = ['static', 'empty'] as const
  type Fallback = typeof VALID_FALLBACKS[number]
  const fallback: Fallback | undefined = (VALID_FALLBACKS as readonly unknown[]).includes(r.fallback)
    ? (r.fallback as Fallback)
    : undefined

  return {
    source: r.source as DynamicBindingSource,
    field: r.field,
    ...(format !== undefined ? { format } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  }
}

/**
 * Parse a raw dynamicBindings map. Invalid entries are silently dropped
 * (per-entry tolerance). Returns `undefined` when no valid bindings remain.
 */
export function parseDynamicBindings(raw: unknown): Record<string, DynamicPropBinding> | undefined {
  const outer = asPlainObject(raw)
  if (!outer) return undefined

  const result: Record<string, DynamicPropBinding> = {}
  for (const [propKey, entry] of Object.entries(outer)) {
    const binding = parseDynamicPropBinding(entry)
    if (!binding) continue
    result[propKey] = binding
  }
  return Object.keys(result).length > 0 ? result : undefined
}
