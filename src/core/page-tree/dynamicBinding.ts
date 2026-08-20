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
 * - `data` — a specific custom-data row, addressed by immutable
 *   row id and field id (`<rowId>.<fieldId>`). Available on every page.
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
  Type.Literal('data'),
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
    'data',
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
