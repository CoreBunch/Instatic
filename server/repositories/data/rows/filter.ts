/**
 * Operator-object filter querying for the `api.cms.content.*` plugin surface.
 *
 *   listDataRowsWithFilter — list rows in a table with operator-object
 *                            filters, sort, and pagination
 *
 * The filter SQL is dialect-naive (ANSI lower/like, the `jsonField()` helper
 * for cells_json paths) — `db-postgres-isms.test.ts` gates against drift.
 */
import { physicalId } from '@core/branches'
import type { DbClient } from '../../../db/client'
import type { BranchScope } from '../../../branches/scope'
import type { DataRow } from '@core/data/schemas'
import { matchesStorageFilterValue, type ContentListOptions, type StorageFilterOperator } from '@core/plugin-sdk'
import { compareDataCellValues, hasLocalizedDataFields, projectLocalizedDataCells, type DataLocalizationContext } from '@core/data/localizedCells'
import { LocalizationError } from '@core/localization'
import { jsonField } from '../../../db/jsonExtract'
import { placeholder, selectHydratedDataRows } from './mapper'
import { getDataTable } from '../tables'
import { listDataRows } from './read'

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
type ListDataRowsFilterOptions = Omit<ContentListOptions, 'language'> & {
  /** Derived query values only; returned rows preserve their authoring references. */
  localization?: DataLocalizationContext
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
 * Ordinary fields use two SQL queries after table-schema lookup: a hydrated SELECT (the
 * filter + pagination live in a `filtered_ids` CTE that the row + user-ref
 * joins are restricted to) plus one COUNT. The CTE keeps the SQL dialect-naive
 * — both Postgres and SQLite support `with` — while collapsing what used to be
 * one hydration round-trip per matching id. Localized tables with an explicit
 * language project the eligible rows before filter/count/order/pagination.
 */
export async function listDataRowsWithFilter(
  db: DbClient,
  scope: BranchScope,
  tableId: string,
  options: ListDataRowsFilterOptions = {},
): Promise<ListDataRowsWithFilterResult> {
  const { filter, orderBy, status = 'any', limit = 100, offset = 0 } = options

  for (const key of Object.keys(filter ?? {})) {
    if (!FIELD_KEY_RE.test(key)) throw new Error(`[content] invalid filter field name: ${JSON.stringify(key)}`)
  }
  for (const key of Object.keys(orderBy ?? {})) {
    if (!ROW_LEVEL_ORDER_KEYS.has(key) && !FIELD_KEY_RE.test(key)) throw new Error(`[content] invalid orderBy field name: ${JSON.stringify(key)}`)
  }

  const table = await getDataTable(db, scope, tableId)
  if (table && hasLocalizedDataFields(table.fields)) {
    const queryFields = [...Object.keys(filter ?? {}), ...Object.keys(orderBy ?? {}).filter(key => !ROW_LEVEL_ORDER_KEYS.has(key))]
    const localizedQuery = queryFields.some(id => {
      const field = table.fields.find(candidate => candidate.id === id)
      return field !== undefined && hasLocalizedDataFields([field])
    })
    if (!options.localization && localizedQuery) throw new LocalizationError('query.language', 'Choose an explicit content language for localized field queries')
    if (options.localization) {
      const localization = options.localization
      const candidates = (await listDataRows(db, scope, tableId))
        .filter(row => status === 'any' || row.status === status)
        .map(row => ({ row, cells: projectLocalizedDataCells(row.cells, table.fields, localization, `rows.${row.id}.cells`) }))
      const matching = candidates.filter(candidate => Object.entries(filter ?? {})
        .every(([key, value]) => matchesStorageFilterValue(candidate.cells[key], value)))
      const orders = Object.entries(orderBy ?? {})
      matching.sort((a, b) => {
        for (const [key, direction] of orders) {
          const aValue = ROW_LEVEL_ORDER_KEYS.has(key) ? rowOrderValue(a.row, key) : a.cells[key]
          const bValue = ROW_LEVEL_ORDER_KEYS.has(key) ? rowOrderValue(b.row, key) : b.cells[key]
          const comparison = compareDataCellValues(aValue, bValue, localization.language, direction)
          if (comparison !== 0) return comparison
        }
        if (orders.length === 0) {
          const updated = b.row.updatedAt.localeCompare(a.row.updatedAt)
          if (updated !== 0) return updated
          const created = b.row.createdAt.localeCompare(a.row.createdAt)
          if (created !== 0) return created
        }
        return a.row.id.localeCompare(b.row.id)
      })
      const start = Math.max(0, offset)
      return { rows: matching.slice(start, start + Math.max(1, Math.min(500, limit))).map(candidate => candidate.row), totalCount: matching.length }
    }
  }

  const params: unknown[] = [physicalId(scope.branchId, tableId)]
  let paramIdx = 1
  function addParam(value: unknown): string {
    params.push(value)
    paramIdx++
    return placeholder(db.dialect, paramIdx)
  }

  let whereSql = `data_rows.table_id = ${placeholder(db.dialect, 1)} and data_rows.deleted_at is null`
  whereSql += ` and data_rows.branch_id = ${addParam(scope.branchId)}`

  if (status !== 'any') {
    whereSql += ` and data_rows.status = ${addParam(status)}`
  }

  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
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
    selectHydratedDataRows(db, scope, {
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

function rowOrderValue(row: DataRow, key: string): string | null {
  switch (key) {
    case 'slug': return row.slug
    case 'status': return row.status
    case 'created_at': return row.createdAt
    case 'updated_at': return row.updatedAt
    case 'published_at': return row.publishedAt
    default: throw new Error(`Unexpected row order field ${key}`)
  }
}
