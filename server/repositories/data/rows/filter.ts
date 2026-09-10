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
import type { DataRow, DataRowStatus } from '@core/data/schemas'
import type { StorageFilterOperator, StorageFilterValue } from '@core/plugin-sdk/storageSchemas'
import { jsonField, jsonFieldExists } from '../../../db/jsonExtract'
import { resolveDataFieldLocalization } from '@core/localization'
import { getDefaultLocale, resolveContentLocale } from '../../localization'
import { getDataTable } from '../tables'
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
  localeId?: string
  filter?: Record<string, StorageFilterValue>
  orderBy?: Record<string, 'asc' | 'desc'>
  status?: 'any' | DataRowStatus
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

  const sourceLocale = await getDefaultLocale(db)
  const locale = options.localeId === undefined ? sourceLocale : await resolveContentLocale(db, options.localeId)
  const table = await getDataTable(db, tableId)
  if (!table) return { rows: [], totalCount: 0 }
  const fields = new Map(table.fields.map((field) => [field.id, field]))
  const params: unknown[] = [locale.id, sourceLocale.id, tableId]
  let paramIdx = 3
  function addParam(value: unknown): string {
    params.push(value)
    paramIdx++
    return placeholder(db.dialect, paramIdx)
  }

  const localizedCte = `localized_rows as (
    select data_rows.id, data_rows.cells_json as shared_cells_json,
           localized.cells_json as locale_cells_json, source.cells_json as source_cells_json,
           coalesce(localized.slug, source.slug, '') as slug,
           case when localized.availability = 'online' and localized.active_version_id is not null then 'published'
                when localized.scheduled_publish_at is not null then 'scheduled'
                when localized.active_version_id is not null then 'unpublished' else 'draft' end as status,
           data_rows.created_at, data_rows.updated_at, localized.published_at
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    left join data_row_localizations localized on localized.row_id = data_rows.id and localized.locale_id = ${placeholder(db.dialect, 1)}
    left join data_row_localizations source on source.row_id = data_rows.id and source.locale_id = ${placeholder(db.dialect, 2)}
    where data_rows.table_id = ${placeholder(db.dialect, 3)} and data_rows.deleted_at is null and data_tables.deleted_at is null
  )`
  function cellExpression(key: string): string {
    const field = fields.get(key)
    if (key === 'slug' && field && resolveDataFieldLocalization(field) === 'localized') return 'slug'
    if (!field || resolveDataFieldLocalization(field) === 'shared') return jsonField('shared_cells_json', key, db.dialect).sql
    const present = jsonFieldExists('locale_cells_json', key, db.dialect).sql
    return `(case when ${present} then ${jsonField('locale_cells_json', key, db.dialect).sql}
      else ${jsonField('source_cells_json', key, db.dialect).sql} end)`
  }
  let whereSql = '1 = 1'

  if (status !== 'any') {
    whereSql += ` and status = ${addParam(status)}`
  }

  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid filter field name: ${JSON.stringify(key)}`)
      }
      const fragment = cellExpression(key)

      if (value === null || typeof value !== 'object') {
        whereSql += value === null ? ` and ${fragment} is null` : ` and ${fragment} = ${addParam(value)}`
      } else {
        const op = value as StorageFilterOperator
        if (op.eq !== undefined) whereSql += op.eq === null ? ` and ${fragment} is null` : ` and ${fragment} = ${addParam(op.eq)}`
        if (op.ne !== undefined) whereSql += op.ne === null ? ` and ${fragment} is not null` : ` and ${fragment} != ${addParam(op.ne)}`
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

  let orderBySql = 'updated_at desc, created_at desc, id asc'
  if (orderBy && Object.keys(orderBy).length > 0) {
    const parts: string[] = []
    for (const [key, dir] of Object.entries(orderBy)) {
      const normalizedDir = dir === 'desc' ? 'desc' : 'asc'
      if (ROW_LEVEL_ORDER_KEYS.has(key)) {
        parts.push(`${key} ${normalizedDir}`)
        continue
      }
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid orderBy field name: ${JSON.stringify(key)}`)
      }
      const fragment = cellExpression(key)
      parts.push(`${fragment} ${normalizedDir}`)
    }
    orderBySql = [...parts, 'id asc'].join(', ')
  }

  const limitPlaceholder = addParam(Math.max(1, Math.min(500, limit)))
  const offsetPlaceholder = addParam(Math.max(0, offset))

  // The CTE selects (and orders + paginates) the matching id page; the outer
  // hydrated SELECT joins it back to data_rows + user refs in one round-trip.
  // The outer `order by` is re-applied because a JOIN does not preserve the
  // CTE's row order.
  const cte = `${localizedCte}, filtered_ids as (
    select id, row_number() over (order by ${orderBySql}) as position
    from localized_rows
    where ${whereSql}
    order by ${orderBySql}
    limit ${limitPlaceholder} offset ${offsetPlaceholder}
  )`

  const countSql = `
    with ${localizedCte}
    select count(*) as total
    from localized_rows
    where ${whereSql}
  `

  const countParams = params.slice(0, countParamCount)

  const [rows, countResult] = await Promise.all([
    selectHydratedDataRows(db, {
      localeId: locale.id,
      cte,
      join: 'join filtered_ids on filtered_ids.id = data_rows.id',
      tail: 'order by filtered_ids.position',
      params,
    }),
    db.unsafe<{ total: number | bigint | string }>(countSql, countParams),
  ])

  return {
    rows,
    totalCount: Number(countResult.rows[0]?.total ?? 0),
  }
}
