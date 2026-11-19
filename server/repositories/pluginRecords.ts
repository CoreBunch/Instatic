/**
 * Plugin-owned records (`plugin_records`): the storage behind
 * `api.cms.storage.collection(...)` and the admin resource pages.
 *
 * Record data is always bound as an object. On Postgres a pre-stringified
 * object bound to the `jsonb` column is stored as a JSON string scalar: it
 * reads back fine, but no `list` filter can see inside it. Rows written that
 * way before migration `036_plugin_records_json_repair` are unwrapped by it.
 */
import type { PluginRecord } from '@core/plugin-sdk'
import type {
  StorageFilterOperator,
  StorageFilterValue,
  StorageListOptions,
} from '@core/plugin-sdk/storageSchemas'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { placeholder, type DbClient } from '../db/client'
import {
  jsonBooleanParam,
  jsonField,
  jsonFieldOrder,
  jsonFieldTyped,
  type JsonScalarKind,
} from '../db/jsonExtract'

interface PluginRecordRow {
  id: string
  plugin_id: string
  resource_id: string
  data_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

const RECORD_COLUMNS = 'id, plugin_id, resource_id, data_json, created_at, updated_at'

/** Record ids already reported as unreadable, so one bad row logs once. */
const reportedUnreadable = new Set<string>()

/**
 * A record's data as an object. A row whose data does not parse, or is not an
 * object, reads as `{}` and is logged once: one damaged row must not make a
 * whole resource unlistable.
 */
function readDataJson(row: Pick<PluginRecordRow, 'id' | 'data_json'>): Record<string, unknown> {
  let parsed: unknown = row.data_json
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = null
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  if (!reportedUnreadable.has(row.id)) {
    reportedUnreadable.add(row.id)
    console.warn(`[plugin:storage] record "${row.id}" holds data that is not a JSON object; reading it as empty`)
  }
  return {}
}

function mapPluginRecord(row: PluginRecordRow): PluginRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    resourceId: row.resource_id,
    data: readDataJson(row),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

/**
 * Refuse data holding the NUL character, in a key or a string anywhere inside.
 * Postgres `jsonb` cannot store it, so accepting it on SQLite would make the
 * same plugin behave differently on the two databases.
 */
function assertStorableRecordData(value: unknown): void {
  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      throw new Error('Plugin record data cannot contain the NUL character (\\u0000)')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertStorableRecordData(item)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertStorableRecordData(key)
      assertStorableRecordData(item)
    }
  }
}

/** Identifier regex — same rule as the jsonField() helper. */
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const COMPARISONS = [
  ['eq', '='],
  ['ne', '!='],
  ['gt', '>'],
  ['gte', '>='],
  ['lt', '<'],
  ['lte', '<='],
] as const

/**
 * Builds the WHERE conditions of one `list` call. Every comparison is typed
 * by the value it compares with: a number matches only rows whose field holds
 * a JSON number, a boolean only booleans, a string only strings (byte-wise).
 * `null` means "the field is missing or null". The same on both dialects; see
 * `jsonFieldTyped`.
 */
function buildFilterSql(
  db: DbClient,
  filter: Record<string, StorageFilterValue>,
  addParam: (value: unknown) => string,
): string[] {
  const conditions: string[] = []

  function compare(key: string, operator: string, value: unknown): string {
    if (value === null) {
      const raw = jsonField('data_json', key, db.dialect).sql
      if (operator === '=') return `${raw} is null`
      if (operator === '!=') return `${raw} is not null`
      throw new Error(`[plugin:storage] filter on "${key}": null can only be used with eq and ne`)
    }
    let kind: JsonScalarKind
    let bound: unknown = value
    if (typeof value === 'number' && Number.isFinite(value)) {
      kind = 'number'
    } else if (typeof value === 'boolean') {
      kind = 'boolean'
      bound = jsonBooleanParam(value, db.dialect)
    } else if (typeof value === 'string') {
      kind = 'text'
    } else {
      throw new Error(`[plugin:storage] filter on "${key}" must compare with a string, number, boolean or null`)
    }
    return `${jsonFieldTyped('data_json', key, db.dialect, kind).sql} ${operator} ${addParam(bound)}`
  }

  for (const [key, value] of Object.entries(filter)) {
    if (!FIELD_KEY_RE.test(key)) {
      throw new Error(`[plugin:storage] invalid filter field name: ${JSON.stringify(key)}`)
    }
    if (value === null || typeof value !== 'object') {
      // Shorthand primitive — treat as eq
      conditions.push(compare(key, '=', value))
      continue
    }
    const op: StorageFilterOperator = value
    for (const [name, operator] of COMPARISONS) {
      if (op[name] !== undefined) conditions.push(compare(key, operator, op[name]))
    }
    if (op.in !== undefined) {
      // Values of mixed types are allowed: each is compared with its own type.
      conditions.push(
        op.in.length === 0 ? '1 = 0' : `(${op.in.map((item) => compare(key, '=', item)).join(' or ')})`,
      )
    }
    if (op.like !== undefined) {
      // Case-insensitive for ASCII letters on both dialects.
      conditions.push(
        `lower(${jsonFieldTyped('data_json', key, db.dialect, 'text').sql}) like lower(${addParam(op.like)})`,
      )
    }
  }
  return conditions
}

export async function listPluginRecords(
  db: DbClient,
  pluginId: string,
  resourceId: string,
  options: StorageListOptions = {},
): Promise<{ records: PluginRecord[]; totalCount: number }> {
  const { filter, orderBy, limit = 100, offset = 0 } = options

  const params: unknown[] = [pluginId, resourceId]
  // Returns the next positional placeholder AND appends the value to params.
  function addParam(value: unknown): string {
    params.push(value)
    return placeholder(db.dialect, params.length)
  }

  const conditions = [
    `plugin_id = ${placeholder(db.dialect, 1)}`,
    `resource_id = ${placeholder(db.dialect, 2)}`,
    ...(filter ? buildFilterSql(db, filter, addParam) : []),
  ]
  const whereSql = conditions.join(' and ')
  // The count query takes the WHERE params only.
  const countParams = params.slice()

  // Fields sort by type, then value (see `jsonFieldOrder`); creation time
  // breaks ties and is the whole order when none is asked for.
  const orderTerms: string[] = []
  for (const [key, direction] of Object.entries(orderBy ?? {})) {
    if (!FIELD_KEY_RE.test(key)) {
      throw new Error(`[plugin:storage] invalid orderBy field name: ${JSON.stringify(key)}`)
    }
    orderTerms.push(jsonFieldOrder('data_json', key, db.dialect, direction === 'desc' ? 'desc' : 'asc').sql)
  }
  orderTerms.push('created_at desc', 'id asc')

  const dataSql = `
    select ${RECORD_COLUMNS}
    from plugin_records
    where ${whereSql}
    order by ${orderTerms.join(', ')}
    limit ${addParam(limit)} offset ${addParam(offset)}
  `
  const countSql = `
    select count(*) as total
    from plugin_records
    where ${whereSql}
  `

  const [dataResult, countResult] = await Promise.all([
    db.unsafe<PluginRecordRow>(dataSql, params),
    db.unsafe<{ total: number | bigint | string }>(countSql, countParams),
  ])

  return {
    records: dataResult.rows.map(mapPluginRecord),
    totalCount: Number(countResult.rows[0]?.total ?? 0),
  }
}

export async function createPluginRecord(
  db: DbClient,
  input: {
    id: string
    pluginId: string
    resourceId: string
    data: Record<string, unknown>
  },
): Promise<PluginRecord> {
  assertStorableRecordData(input.data)
  const { rows } = await db<PluginRecordRow>`
    insert into plugin_records (id, plugin_id, resource_id, data_json)
    values (${input.id}, ${input.pluginId}, ${input.resourceId}, ${input.data})
    returning id, plugin_id, resource_id, data_json, created_at, updated_at
  `
  return mapPluginRecord(rows[0])
}

export async function updatePluginRecord(
  db: DbClient,
  input: {
    id: string
    pluginId: string
    resourceId: string
    data: Record<string, unknown>
  },
): Promise<PluginRecord | null> {
  assertStorableRecordData(input.data)
  const { rows } = await db<PluginRecordRow>`
    update plugin_records set data_json = ${input.data}, updated_at = ${nowIso()}
    where id = ${input.id} and plugin_id = ${input.pluginId} and resource_id = ${input.resourceId}
    returning id, plugin_id, resource_id, data_json, created_at, updated_at
  `
  return rows[0] ? mapPluginRecord(rows[0]) : null
}

export async function deletePluginRecord(
  db: DbClient,
  input: { id: string; pluginId: string; resourceId: string },
): Promise<boolean> {
  const { rowCount } = await db`
    delete from plugin_records
    where id = ${input.id} and plugin_id = ${input.pluginId} and resource_id = ${input.resourceId}
  `
  return rowCount > 0
}
