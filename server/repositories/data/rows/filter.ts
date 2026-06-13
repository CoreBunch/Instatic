/**
 * Operator-object filter querying for the `api.cms.content.*` plugin surface.
 *
 *   listDataRowsWithFilter — list rows in a table with operator-object
 *                            filters, sort, and pagination
 *
 * The filter SQL is dialect-naive (ANSI lower/like, the `jsonField()` helper
 * for cells_json paths) — `db-postgres-isms.test.ts` gates against drift.
 */
import type { DbClient } from '../../../db/client'
import type { DataRow } from '@core/data/schemas'
import type { StorageFilterOperator, StorageFilterValue } from '@core/plugin-sdk/storageSchemas'
import { jsonField } from '../../../db/jsonExtract'
import { placeholder, selectHydratedDataRows } from './mapper'

/**
 * Options accepted by `listDataRowsWithFilter`. Mirrors the plugin SDK's
 * StorageListOptions shape (operator-object filter, asc/desc orderBy,
 * limit/offset) plus a status filter scoped to the row's lifecycle.
 *
 * `filter` keys are top-level JSON paths under `cells_json` (e.g. `title`,
 * `featuredMedia`). The repository validates each key against an identifier
 * regex before splicing it into SQL.
 *
 * `orderBy` accepts JSON-cell paths AND the four row-level columns
 * `slug` / `status` / `created_at` / `updated_at` (recognised by suffix
 * so the SQL stays dialect-naive).
 */
interface ListDataRowsFilterOptions {
  filter?: Record<string, StorageFilterValue>
  orderBy?: Record<string, 'asc' | 'desc'>
  status?: 'any' | 'draft' | 'published' | 'scheduled'
  limit?: number
  offset?: number
}

interface ListDataRowsWithFilterResult {
  rows: DataRow[]
  totalCount: number
}

/** Identifier regex — same rule as `jsonField`. */
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Row-level columns plugins are allowed to order by directly. */
const ROW_LEVEL_ORDER_KEYS = new Set([
  'slug',
  'status',
  'created_at',
  'updated_at',
  'published_at',
])

/**
 * List rows in a table with operator-object filters, sort, and pagination.
 *
 * Two queries total, independent of page size: a single hydrated SELECT (the
 * filter + pagination live in a `filtered_ids` CTE that the row + user-ref
 * joins are restricted to) plus one COUNT. The CTE keeps the SQL dialect-naive
 * — both Postgres and SQLite support `with` — while collapsing what used to be
 * one hydration round-trip per matching id.
 */
export async function listDataRowsWithFilter(
  db: DbClient,
  tableId: string,
  options: ListDataRowsFilterOptions = {},
): Promise<ListDataRowsWithFilterResult> {
  const { filter, orderBy, status = 'any', limit = 100, offset = 0 } = options

  const params: unknown[] = [tableId]
  let paramIdx = 1
  function addParam(value: unknown): string {
    params.push(value)
    paramIdx++
    return placeholder(db.dialect, paramIdx)
  }

  let whereSql = `data_rows.table_id = ${placeholder(db.dialect, 1)} and data_rows.deleted_at is null`

  if (status !== 'any') {
    whereSql += ` and data_rows.status = ${addParam(status)}`
  }

  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid filter field name: ${JSON.stringify(key)}`)
      }
      const fragment = jsonField('cells_json', key, db.dialect).sql

      if (value === null || typeof value !== 'object') {
        whereSql += ` and ${fragment} = ${addParam(value)}`
      } else {
        const op = value as StorageFilterOperator
        if (op.eq !== undefined) whereSql += ` and ${fragment} = ${addParam(op.eq)}`
        if (op.ne !== undefined) whereSql += ` and ${fragment} != ${addParam(op.ne)}`
        if (op.gt !== undefined) whereSql += ` and ${fragment} > ${addParam(op.gt)}`
        if (op.gte !== undefined) whereSql += ` and ${fragment} >= ${addParam(op.gte)}`
        if (op.lt !== undefined) whereSql += ` and ${fragment} < ${addParam(op.lt)}`
        if (op.lte !== undefined) whereSql += ` and ${fragment} <= ${addParam(op.lte)}`
        if (op.in !== undefined) {
          if (op.in.length === 0) {
            whereSql += ` and 1=0`
          } else {
            const inPlaceholders = op.in.map((v) => addParam(v))
            whereSql += ` and ${fragment} in (${inPlaceholders.join(', ')})`
          }
        }
        if (op.like !== undefined) {
          whereSql += ` and lower(${fragment}) like lower(${addParam(op.like)})`
        }
      }
    }
  }

  const countParamCount = params.length

  let orderBySql = 'data_rows.updated_at desc, data_rows.created_at desc'
  if (orderBy && Object.keys(orderBy).length > 0) {
    const parts: string[] = []
    for (const [key, dir] of Object.entries(orderBy)) {
      const normalizedDir = dir === 'desc' ? 'desc' : 'asc'
      if (ROW_LEVEL_ORDER_KEYS.has(key)) {
        parts.push(`data_rows.${key} ${normalizedDir}`)
        continue
      }
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid orderBy field name: ${JSON.stringify(key)}`)
      }
      const fragment = jsonField('cells_json', key, db.dialect).sql
      parts.push(`${fragment} ${normalizedDir}`)
    }
    orderBySql = parts.join(', ')
  }

  const limitPlaceholder = addParam(Math.max(1, Math.min(500, limit)))
  const offsetPlaceholder = addParam(Math.max(0, offset))

  // The CTE selects (and orders + paginates) the matching id page; the outer
  // hydrated SELECT joins it back to data_rows + user refs in one round-trip.
  // The outer `order by` is re-applied because a JOIN does not preserve the
  // CTE's row order.
  const cte = `filtered_ids as (
    select data_rows.id
    from data_rows
    where ${whereSql}
    order by ${orderBySql}
    limit ${limitPlaceholder} offset ${offsetPlaceholder}
  )`

  const countSql = `
    select count(*) as total
    from data_rows
    where ${whereSql}
  `

  const countParams = params.slice(0, countParamCount)

  const [rows, countResult] = await Promise.all([
    selectHydratedDataRows(db, {
      cte,
      join: 'join filtered_ids on filtered_ids.id = data_rows.id',
      tail: `order by ${orderBySql}`,
      params,
    }),
    db.unsafe<{ total: number | bigint | string }>(countSql, countParams),
  ])

  return {
    rows,
    totalCount: Number(countResult.rows[0]?.total ?? 0),
  }
}
