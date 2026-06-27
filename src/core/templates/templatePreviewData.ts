/**
 * Template preview data — generate synthetic `LoopItem` values from a
 * `DataTable`'s field definitions so the editor canvas can preview a
 * template page without needing a real published row.
 *
 * Used by the editor in two paths:
 *  - Canvas preview: render a template page with representative data so
 *    editors can see layout and styling without publishing a real row.
 *  - Loop preview items: fill `base.loop` nodes on a template page with
 *    representative items from the table's field definitions.
 *
 * Preview values are intentionally generic (Lorem ipsum, placeholder
 * numbers, today's date). Real data is never fetched here — the DB is
 * not available in the browser context.
 */

import type { DataTable, DataField, DataRowCells } from '@core/data/schemas'
import {
  POST_TYPE_FIELD_BODY,
  POST_TYPE_FIELD_FEATURED_MEDIA,
  POST_TYPE_FIELD_SLUG,
  POST_TYPE_FIELD_TITLE,
} from '@core/data/schemas'
import type { LoopItem } from '@core/loops/types'
import { normalizeRouteBase } from './templateMatching'

// ---------------------------------------------------------------------------
// Preview cell generation
// ---------------------------------------------------------------------------

/**
 * Post-type built-in field ids → contextual preview value. Adding a new
 * built-in override (or tweaking the wording of an existing one) is a
 * single-line edit here; the per-type handlers below check this map before
 * falling back to the user-provided `defaultValue` or a generic placeholder.
 *
 * Only text-like fields (`text` / `longText` / `richText`) consult this map —
 * none of the other built-in post-type fields override the type's generic
 * preview (e.g. `featuredMedia` stays `null` like any other `media` field).
 */
const POST_TYPE_PREVIEW_VALUE_BY_FIELD_ID: Record<string, string> = {
  [POST_TYPE_FIELD_TITLE]: 'Example Post Title',
  [POST_TYPE_FIELD_SLUG]: 'example-post-title',
  [POST_TYPE_FIELD_BODY]:
    '## Example heading\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Pellentesque at porta est.',
}

/** All text-like field variants share the same override → defaultValue → fallback resolution. */
type TextLikeField = Extract<DataField, { type: 'text' | 'longText' | 'richText' }>

function previewTextLikeValue(field: TextLikeField, fallback: string): string {
  return POST_TYPE_PREVIEW_VALUE_BY_FIELD_ID[field.id] ?? field.defaultValue ?? fallback
}

/**
 * Generate a sensible preview value for a single field.
 *
 * Each switch arm is a one-liner: post-type built-in overrides live in
 * `POST_TYPE_PREVIEW_VALUE_BY_FIELD_ID`, and the text-like resolution chain
 * is centralized in `previewTextLikeValue`. Adding a new `DataField['type']`
 * is a one-row edit here; TypeScript's exhaustive check in the `default`
 * arm enforces coverage of every discriminated-union variant.
 */
function previewValueForField(field: DataField): unknown {
  switch (field.type) {
    case 'text': return previewTextLikeValue(field, 'Lorem ipsum')
    case 'longText': return previewTextLikeValue(field, 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.')
    case 'richText': return previewTextLikeValue(field, 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.')
    case 'number': return field.defaultValue ?? 42
    case 'boolean': return field.defaultValue ?? false
    case 'date': return new Date().toISOString().split('T')[0]
    case 'dateTime': return new Date().toISOString()
    case 'select': return field.defaultValue ?? field.options[0]?.value ?? null
    case 'multiSelect': return field.options.length > 0 ? [field.options[0]!.value] : []
    case 'url': return 'https://example.com'
    case 'email': return 'hello@example.com'
    // No synthetic media URL — modules that render a media field must handle null gracefully.
    case 'media': return null
    case 'relation': return null
    // Structural types: pageTree and fieldSchema hold whole documents, not scalar values.
    // Preview data generation has no meaningful value to produce for them.
    case 'pageTree': return null
    case 'fieldSchema': return []
    case 'seoMetadata': return {
      title: 'Example Post — Site Name',
      description: 'A short description of this example post for search engines.',
    }
    default: {
      // Exhaustive check: TypeScript will error here if a new field type
      // is added to the discriminated union without a case above.
      const _exhaustive: never = field
      void _exhaustive
      return null
    }
  }
}

/**
 * Build a synthetic `DataRowCells` payload from a table's field definitions.
 * Every field in `table.fields` gets a preview value via `previewValueForField`.
 */
export function buildPreviewCells(table: DataTable): DataRowCells {
  const cells: DataRowCells = {}
  for (const field of table.fields) {
    cells[field.id] = previewValueForField(field)
  }
  return cells
}

// ---------------------------------------------------------------------------
// LoopItem projection
// ---------------------------------------------------------------------------

/**
 * Convert a `DataTable`'s field definitions into a synthetic `LoopItem` for
 * canvas preview. The item's `fields` map mirrors the shape produced at
 * runtime by `publishedDataRowToLoopItem` so template bindings resolve the
 * same way during preview as they do when rendering a real published row.
 */
export function dataTablePreviewToLoopItem(table: DataTable): LoopItem {
  const cells = buildPreviewCells(table)
  const tableRouteBase = normalizeRouteBase(table.routeBase || `/${table.slug}`)
  const slugValue = typeof cells[POST_TYPE_FIELD_SLUG] === 'string' && cells[POST_TYPE_FIELD_SLUG]
    ? cells[POST_TYPE_FIELD_SLUG] as string
    : 'preview-row'
  const permalink = `${tableRouteBase === '/' ? '' : tableRouteBase}/${slugValue}`

  // Determine featured media field: post-type tables have a known field id;
  // for generic data tables we look for the first `media` field.
  const hasFeaturedMediaField = table.fields.some((f) => f.id === POST_TYPE_FIELD_FEATURED_MEDIA)
  const featuredMediaField = hasFeaturedMediaField
    ? POST_TYPE_FIELD_FEATURED_MEDIA
    : table.fields.find((f) => f.type === 'media')?.id ?? null

  return {
    id: '__preview__',
    fields: {
      // Cells — all user-defined fields accessible by fieldId
      ...cells,
      // System identity (overlay so these can never be shadowed by cells)
      id: '__preview__',
      rowId: '__preview__',
      tableId: table.id,
      tableSlug: table.slug,
      // No real people in preview
      author: null,
      authorName: null,
      authorRoleSlug: null,
      authorRoleName: null,
      publishedBy: null,
      publishedByName: null,
      publishedByRoleSlug: null,
      publishedByRoleName: null,
      // Media aliases — no resolved path in preview
      featuredMediaId: featuredMediaField ? cells[featuredMediaField] ?? null : null,
      featuredMedia: null,
      featuredMediaPath: null,
      featuredMediaUrl: null,
      firstImage: null,
      firstImagePath: null,
      firstImageUrl: null,
      // Dates / routing
      slug: slugValue,
      publishedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      permalink,
    },
  }
}
