/**
 * Cell-value helpers — typed accessors over a `DataRowCells` payload.
 *
 * `cells_json` is `Record<string, unknown>` at the persistence boundary. To
 * keep callers honest, every read goes through one of these helpers, which
 * narrow the unknown to the field's expected runtime type and fall back to
 * a sensible default when the cell is missing or malformed.
 */

import { NodeTreeSchema, type NodeTree } from '@core/page-tree'
import type { BaseNode } from '@core/page-tree'
import { parseSeoMetadata, type SeoMetadata } from '@core/seo'
import { DataFieldSchema, type DataField, type DataRowCells, type DataTable } from './schemas'
import { dataTableHasField } from './fields'
import { slugFromTitle } from '@core/utils/slug'
import { safeParseValue } from '@core/utils/typeboxHelpers'

export function readStringCell(cells: DataRowCells, fieldId: string, fallback = ''): string {
  const value = cells[fieldId]
  return typeof value === 'string' ? value : fallback
}

function readNullableStringCell(cells: DataRowCells, fieldId: string): string | null {
  const value = cells[fieldId]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readNumberCell(cells: DataRowCells, fieldId: string): number | null {
  const value = cells[fieldId]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readBooleanCell(cells: DataRowCells, fieldId: string): boolean {
  const value = cells[fieldId]
  return typeof value === 'boolean' ? value : false
}

export function readStringArrayCell(cells: DataRowCells, fieldId: string): string[] {
  const value = cells[fieldId]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Convenience for the post-type built-in field ids. These are read often
 * enough that giving them a named accessor avoids string-literal sprawl.
 */
export function readTitleCell(cells: DataRowCells): string {
  return readStringCell(cells, 'title')
}

export function readSlugCell(cells: DataRowCells): string {
  return readStringCell(cells, 'slug')
}

/**
 * Derive the denormalized, routable slug for a row in a given table.
 * Returns an empty string when the table has no slug field — the unique
 * index on `data_rows` excludes empty strings, so non-routable tables can
 * hold many rows without slug conflicts.
 */
export function slugForTable(table: Pick<DataTable, 'fields'>, cells: DataRowCells): string {
  if (!dataTableHasField(table, 'slug')) return ''
  const rawSlug = readSlugCell(cells)
  return rawSlug ? slugFromTitle(rawSlug) : ''
}

export function readBodyCell(cells: DataRowCells): string {
  return readStringCell(cells, 'body')
}

export function readFeaturedMediaCell(cells: DataRowCells): string | null {
  return readNullableStringCell(cells, 'featuredMedia')
}

/**
 * Read the structured `seo` cell (built-in `seoMetadata` field). Returns
 * `undefined` when the cell is missing or malformed — a corrupt SEO object
 * must never block loading the row.
 */
export function readSeoCell(cells: DataRowCells): SeoMetadata | undefined {
  return parseSeoMetadata(cells.seo)
}

/**
 * Read a `pageTree` cell value. Returns the validated `NodeTree` or null if
 * the cell is missing or does not conform to the expected shape.
 *
 * The generic parameter is `BaseNode` (the persistence-level node shape).
 * Callers that work with richer node types (e.g. `PageNode`) may cast the
 * result — the schema validates the base shape which is structurally
 * compatible.
 */
export function readNodeTreeCell(
  cells: DataRowCells,
  fieldId: string,
): NodeTree<BaseNode> | null {
  const raw = cells[fieldId]
  if (!raw) return null
  const result = safeParseValue(NodeTreeSchema, raw)
  return result.ok ? result.value : null
}

/**
 * Read a `fieldSchema` cell value. Returns the array of `DataField` items,
 * silently dropping any that fail validation. Returns an empty array when the
 * cell is missing or not an array.
 */
export function readFieldSchemaCell(
  cells: DataRowCells,
  fieldId: string,
): DataField[] {
  const raw = cells[fieldId]
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const result = safeParseValue(DataFieldSchema, item)
    return result.ok ? [result.value] : []
  })
}
