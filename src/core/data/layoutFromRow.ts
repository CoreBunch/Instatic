/**
 * Bidirectional adapter between `SavedLayout` (in-memory type) and
 * `DataRow` / `DataRowCells` (the unified storage layer).
 *
 * Saved layouts are stored in `data_rows` where `table_id = 'layouts'`.
 * The `layouts` system table fields map to SavedLayout fields as follows:
 *
 *   row.id               → layout.id   (the row id IS the layout id)
 *   cells.name           → layout.name
 *   cells.body           → { nodes, rootNodeId } (pageTree field = snapshot subtree)
 *   cells.classes        → layout.classes (StyleRule registry stored as JSON object)
 *   row.createdAt (ISO)  → layout.createdAt (epoch ms)
 */

import type { DataRow, DataRowCells } from '@core/data/schemas'
import { parseSavedLayout, type SavedLayout } from '@core/layouts'

// ---------------------------------------------------------------------------
// DataRow → SavedLayout
// ---------------------------------------------------------------------------

/**
 * Reconstruct a `SavedLayout` from a `DataRow` (table_id = 'layouts').
 *
 * Uses `parseSavedLayout` internally so all tolerance logic (dropped invalid
 * nodes/classes, createdAt fallback) is centralised. Returns `null` when the
 * row's cells are so corrupt that a valid layout cannot be reconstructed.
 */
export function savedLayoutFromRow(row: DataRow): SavedLayout | null {
  const cells = row.cells

  // cells.body is a pageTree cell: { nodes, rootNodeId }.
  const body =
    cells.body && typeof cells.body === 'object' && !Array.isArray(cells.body)
      ? (cells.body as Record<string, unknown>)
      : {}

  const rawLayout = {
    id: row.id,
    name: typeof cells.name === 'string' ? cells.name : '',
    rootNodeId: typeof body.rootNodeId === 'string' ? body.rootNodeId : '',
    nodes: body.nodes ?? {},
    classes: cells.classes ?? {},
    // Convert ISO datetime string to epoch milliseconds.
    createdAt: typeof row.createdAt === 'string'
      ? (Date.parse(row.createdAt) || Date.now())
      : Date.now(),
  }

  return parseSavedLayout(rawLayout)
}

// ---------------------------------------------------------------------------
// SavedLayout → DataRowCells
// ---------------------------------------------------------------------------

/**
 * Convert a `SavedLayout` to the `DataRowCells` shape for storage in
 * `data_rows`.
 *
 * The `slug` is derived from the name (kebab-case) and should also be passed
 * as the `slug` parameter to `createDataRow` / `updateDataRowDraftCells` (the
 * denormalized column on `data_rows`). Uniqueness is enforced by the
 * `data_rows_table_slug_active_idx` partial index.
 */
export function savedLayoutToCells(layout: SavedLayout): DataRowCells {
  return {
    name: layout.name,
    slug: layoutSlugFromName(layout.name),
    body: {
      nodes: layout.nodes,
      rootNodeId: layout.rootNodeId,
    },
    classes: layout.classes,
  }
}

/**
 * Derive the storage slug from a saved-layout name.
 * Converts to lower-kebab-case; falls back to 'layout' on empty input.
 */
export function layoutSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
  return slug || 'layout'
}
