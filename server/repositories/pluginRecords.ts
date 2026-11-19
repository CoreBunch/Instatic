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
  jsonColumnIsObject,
  jsonField,
  jsonFieldOrder,
  jsonFieldTyped,
  jsonTextLike,
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

/** How deep record data may nest. Far beyond any real record; small enough to serialise safely. */
const MAX_RECORD_DEPTH = 512

/**
 * Whether a parsed value nests deeper than `MAX_RECORD_DEPTH`. Walks with an
 * explicit stack: the point is to find the values a recursive walk (or
 * `JSON.stringify`) would overflow on.
 */
function nestsTooDeep(root: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { value, depth } = next
    if (!value || typeof value !== 'object') continue
    if (depth >= MAX_RECORD_DEPTH) return true
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
    }
  }
  return false
}

/** The stored data of a record could not be read, so it cannot be updated. */
export class PluginRecordUnreadableError extends Error {
  constructor() {
    super(
      'The stored data of this record could not be read, so it cannot be updated. Delete it and create it again.',
    )
    this.name = 'PluginRecordUnreadableError'
  }
}

/** Record ids already reported as unreadable, so one bad row logs once. */
const reportedUnreadable = new Set<string>()

/**
 * A record's data as an object, or null when it cannot be read as one.
 *
 * A string is parsed: SQLite stores JSON as text, and on Postgres a row
 * written before migration 036 (and not unwrapped by it) is a string scalar
 * holding the object. Anything that does not parse to an object, or nests
 * deeper than a record may, is damaged.
 */
function readDataJson(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      // Not JSON (or nested too deep to parse): damaged, reported by the caller.
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  // Parsing copes with any depth, but everything after it (serialising the
  // record to the plugin or the admin) recurses and would overflow.
  if (nestsTooDeep(parsed)) return null
  return parsed as Record<string, unknown>
}

/**
 * One damaged row must not make a whole resource unlistable: it is returned
 * with empty data and `unreadable: true`, and logged once.
 */
function mapPluginRecord(row: PluginRecordRow): PluginRecord {
  const data = readDataJson(row.data_json)
  if (data === null && !reportedUnreadable.has(row.id)) {
    reportedUnreadable.add(row.id)
    console.warn(
      `[plugin:${row.plugin_id}] record "${row.id}" in "${row.resource_id}" holds data that is not a JSON object; it reads as empty`,
    )
  }
  return {
    id: row.id,
    pluginId: row.plugin_id,
    resourceId: row.resource_id,
    data: data ?? {},
    ...(data === null ? { unreadable: true as const } : {}),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

/** A high surrogate with no low one after it, or a low one with no high one before. */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Refuse text Postgres cannot store: the NUL character, and an unpaired
 * surrogate (ill-formed UTF-16), in a key or a string anywhere inside. SQLite
 * would take both, so accepting them there would make one plugin behave
 * differently on the two databases. Also refuse data nested so deep that it
 * could not be read back.
 */
function assertStorableRecordData(value: unknown, depth = 0): void {
  if (depth > MAX_RECORD_DEPTH) {
    throw new Error(`Plugin record data cannot nest deeper than ${MAX_RECORD_DEPTH} levels`)
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000') || UNPAIRED_SURROGATE.test(value)) {
      throw new Error(
        'Plugin record data cannot contain the NUL character (\\u0000) or an unpaired surrogate',
      )
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertStorableRecordData(item, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertStorableRecordData(key)
      assertStorableRecordData(item, depth + 1)
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
      conditions.push(jsonTextLike('data_json', key, db.dialect, addParam(op.like)).sql)
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

/**
 * Replace a record's data. Returns null when the record does not exist.
 * Throws `PluginRecordUnreadableError` for a record whose stored data cannot
 * be read: overwriting it would silently replace whatever it held with the
 * edit alone.
 */
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
  const write = (guard: string) =>
    db.unsafe<PluginRecordRow>(
      `update plugin_records
          set data_json = ${placeholder(db.dialect, 1)}, updated_at = ${placeholder(db.dialect, 2)}
        where id = ${placeholder(db.dialect, 3)} and plugin_id = ${placeholder(db.dialect, 4)} and resource_id = ${placeholder(db.dialect, 5)}${guard}
        returning ${RECORD_COLUMNS}`,
      [input.data, nowIso(), input.id, input.pluginId, input.resourceId],
    )

  // One statement for the ordinary case: the row exists and holds an object.
  const guarded = await write(` and ${jsonColumnIsObject('data_json', db.dialect).sql}`)
  if (guarded.rows[0]) return mapPluginRecord(guarded.rows[0])

  // Nothing matched: the record is missing, damaged, or (Postgres) still in
  // the string form migration 036 could not unwrap but the reader can.
  const { rows } = await db.unsafe<PluginRecordRow>(
    `select ${RECORD_COLUMNS} from plugin_records
      where id = ${placeholder(db.dialect, 1)} and plugin_id = ${placeholder(db.dialect, 2)} and resource_id = ${placeholder(db.dialect, 3)}`,
    [input.id, input.pluginId, input.resourceId],
  )
  if (!rows[0]) return null
  if (readDataJson(rows[0].data_json) === null) throw new PluginRecordUnreadableError()
  const plain = await write('')
  return plain.rows[0] ? mapPluginRecord(plain.rows[0]) : null
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
