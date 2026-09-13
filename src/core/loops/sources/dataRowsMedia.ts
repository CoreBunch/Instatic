/**
 * Media resolution for the `data.rows` loop source.
 *
 * Media ids live inside `cells_json`, not as SQL columns — the built-in
 * `featuredMedia` cell plus every user-defined `media` field, including the
 * ones nested inside repeater items. Resolving them in SQL would mean a join
 * per field and a query shape that differs per table, so the ids are gathered
 * in TypeScript instead: one pass over the page of rows collects every id, and
 * a SINGLE batched `in (…)` query turns them into public paths. One round trip
 * regardless of how many rows or how many media fields the slice touched.
 *
 * This lives beside `dataRows.ts` rather than inside it because the two answer
 * different questions. That file decides WHICH rows a loop returns — the
 * filter, the order, the page window. This one decides what a row's media
 * cells CONTAIN once those rows are in hand.
 */

import type { LoopSourceDb } from '@core/loops/types'
import { readFeaturedMediaCell, readMediaCellIds, readRepeaterCell } from '@core/data/cells'
import type { DataField, DataRowCells, RepeaterItemField } from '@core/data/schemas'

interface MediaAssetRow {
  id: string
  public_path: string
}

/** Media fields appear at the top level and inside repeater items alike. */
type MediaProjectionField = DataField | RepeaterItemField

/** Dialect-appropriate positional placeholder: `$1` on Postgres, `?` on SQLite. */
function positionalParam(db: LoopSourceDb, index: number): string {
  return db.dialect === 'postgres' ? `$${index}` : '?'
}

/**
 * Resolve a set of media asset ids to their `public_path` values in one query.
 * Uses `db.unsafe` with dialect-appropriate positional placeholders so the same
 * code works on both Postgres and SQLite. Ids absent from the database — or
 * soft-deleted — are absent from the returned map.
 */
export async function resolveMediaIdsToPaths(
  db: LoopSourceDb,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const idList = [...new Set(ids)]
  const pathMap = new Map<string, string>()
  if (idList.length === 0) return pathMap
  const placeholders = idList.map((_, i) => positionalParam(db, i + 1)).join(', ')
  const { rows } = await db.unsafe<MediaAssetRow>(
    `select id, public_path
     from media_assets
     where id in (${placeholders}) and deleted_at is null`,
    idList,
  )
  for (const row of rows) pathMap.set(row.id, row.public_path)
  return pathMap
}

function collectFieldMediaIds(
  cells: DataRowCells,
  fields: readonly MediaProjectionField[],
  ids: string[],
): void {
  for (const field of fields) {
    if (field.type === 'media') {
      ids.push(...readMediaCellIds(cells, field.id))
      continue
    }
    if (field.type !== 'repeater') continue
    for (const item of readRepeaterCell(cells, field.id)) {
      collectFieldMediaIds(item.cells, field.fields, ids)
    }
  }
}

/**
 * Collect every media id referenced by a page of rows: the built-in
 * `featuredMedia` cell plus every schema-declared media field. Repeater media
 * is traversed recursively, and multi-value cells contribute every id while
 * still resolving through one batched query.
 */
export function collectMediaIds(
  rows: Array<{ cells_json: Record<string, unknown> }>,
  fields: readonly DataField[],
): string[] {
  const ids: string[] = []
  for (const row of rows) {
    const cells = row.cells_json as DataRowCells
    const featured = readFeaturedMediaCell(cells)
    if (featured) ids.push(featured)
    collectFieldMediaIds(cells, fields, ids)
  }
  return ids
}

/**
 * Resolve schema-declared media ids without changing collection cardinality:
 * scalar media becomes a public path (or null), multi-media stays an ordered
 * array of resolvable public paths, and repeater items keep their `{ id, cells }`
 * shape while media inside `cells` is projected recursively.
 */
export function resolvedMediaOverlay(
  cells: DataRowCells,
  fields: readonly MediaProjectionField[],
  mediaPathMap: Map<string, string>,
): DataRowCells {
  const overlay: DataRowCells = {}
  for (const field of fields) {
    if (field.type === 'media') {
      const ids = readMediaCellIds(cells, field.id)
      if (field.allowMultiple === true) {
        overlay[field.id] = ids.flatMap((id) => {
          const path = mediaPathMap.get(id)
          return path ? [path] : []
        })
      } else {
        const id = ids[0]
        overlay[field.id] = id ? (mediaPathMap.get(id) ?? null) : null
      }
      continue
    }
    if (field.type !== 'repeater') continue
    overlay[field.id] = readRepeaterCell(cells, field.id).map((item) => ({
      ...item,
      cells: {
        ...item.cells,
        ...resolvedMediaOverlay(item.cells, field.fields, mediaPathMap),
      },
    }))
  }
  return overlay
}
