/**
 * Plugin-owned records (`plugin_records`): the storage behind
 * `api.cms.storage.collection(...)` and the admin resource pages.
 *
 * Record data is always bound as an object. On Postgres a pre-stringified
 * object bound to the `jsonb` column is stored as a JSON string scalar: it
 * reads back fine, but no `list` filter can see inside it. Rows written that
 * way before migration `036_plugin_records_json_repair` are unwrapped by it.
 *
 * Plugin handlers interleave (one worker per plugin per process, one worker
 * per server instance), so every write here is a single statement whose
 * outcome the database decides: "create if absent" rides the unique index on
 * `(plugin_id, resource_id, unique_key)`, and a conditional update compares
 * `version` in its WHERE clause. Nothing reads first and writes second.
 */
import type { PluginRecord } from '@core/plugin-sdk'
import type {
  StorageFilterOperator,
  StorageFilterValue,
  StorageListOptions,
} from '@core/plugin-sdk/storageSchemas'
import { deriveRecordUniqueKey } from '@core/plugins/manifest'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { placeholder, type DbClient } from '../db/client'
import { isUniqueViolation } from '../db/errors'
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
  unique_key: string | null
  version: number | bigint | string
  created_at: Date | string
  updated_at: Date | string
}

const RECORD_COLUMNS = 'id, plugin_id, resource_id, data_json, unique_key, version, created_at, updated_at'

/** A record with this unique key already exists in the resource. */
export class PluginRecordDuplicateError extends Error {
  readonly uniqueKey: string

  constructor(uniqueKey: string) {
    super(`A record with the key "${uniqueKey}" already exists.`)
    this.name = 'PluginRecordDuplicateError'
    this.uniqueKey = uniqueKey
  }
}

/** The record changed since the caller read it (`ifVersion` did not match). */
export class PluginRecordConflictError extends Error {
  readonly currentVersion: number

  constructor(currentVersion: number) {
    super(`The record changed since it was read (it is now at version ${currentVersion}).`)
    this.name = 'PluginRecordConflictError'
    this.currentVersion = currentVersion
  }
}

/**
 * Record data is written as an object, never a pre-stringified one: on
 * Postgres a JSON string bound to the `jsonb` column is stored as a string
 * scalar, which reads back fine but matches no `list` filter. Rows written
 * that way before migration 036 are repaired by it; the read below still
 * accepts a string so one stray row cannot break a list.
 */
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
    uniqueKey: row.unique_key,
    version: Number(row.version),
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

interface RecordScope {
  pluginId: string
  resourceId: string
}

interface RecordWrite extends RecordScope {
  id: string
  data: Record<string, unknown>
  /** Derived from the resource's `uniqueField`; null when it has none. */
  uniqueKey: string | null
}

/**
 * Insert unless the unique key is taken. One statement: the unique index
 * decides, so concurrent callers (other handlers, other instances) cannot
 * both insert. Returns null when the key already exists.
 */
async function insertPluginRecord(db: DbClient, input: RecordWrite): Promise<PluginRecord | null> {
  assertStorableRecordData(input.data)
  const { rows } = await db.unsafe<PluginRecordRow>(
    `insert into plugin_records (id, plugin_id, resource_id, data_json, unique_key)
     values (${placeholder(db.dialect, 1)}, ${placeholder(db.dialect, 2)}, ${placeholder(db.dialect, 3)}, ${placeholder(db.dialect, 4)}, ${placeholder(db.dialect, 5)})
     on conflict do nothing
     returning ${RECORD_COLUMNS}`,
    [input.id, input.pluginId, input.resourceId, input.data, input.uniqueKey],
  )
  return rows[0] ? mapPluginRecord(rows[0]) : null
}

/** Create a record. Throws `PluginRecordDuplicateError` when its key is taken. */
export async function createPluginRecord(db: DbClient, input: RecordWrite): Promise<PluginRecord> {
  const created = await insertPluginRecord(db, input)
  if (created) return created
  // No row came back: the only conflict an insert with a fresh id can hit is
  // the unique key.
  throw new PluginRecordDuplicateError(input.uniqueKey ?? '')
}

/**
 * Create the record, or return the one that already holds its key. `created`
 * tells the caller which happened, which is what makes "process this event
 * exactly once" possible.
 */
export async function createPluginRecordIfAbsent(
  db: DbClient,
  input: RecordWrite & { uniqueKey: string },
): Promise<{ record: PluginRecord; created: boolean }> {
  // The holder of the key can be deleted between our insert and our read, so
  // try again a bounded number of times before giving up.
  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await insertPluginRecord(db, input)
    if (created) return { record: created, created: true }
    const existing = await getPluginRecordByKey(db, input, input.uniqueKey)
    if (existing) return { record: existing, created: false }
  }
  throw new Error('[plugin:storage] the record for this key kept changing; try again')
}

export async function getPluginRecord(
  db: DbClient,
  scope: RecordScope,
  id: string,
): Promise<PluginRecord | null> {
  const { rows } = await db.unsafe<PluginRecordRow>(
    `select ${RECORD_COLUMNS} from plugin_records
     where id = ${placeholder(db.dialect, 1)} and plugin_id = ${placeholder(db.dialect, 2)} and resource_id = ${placeholder(db.dialect, 3)}`,
    [id, scope.pluginId, scope.resourceId],
  )
  return rows[0] ? mapPluginRecord(rows[0]) : null
}

export async function getPluginRecordByKey(
  db: DbClient,
  scope: RecordScope,
  uniqueKey: string,
): Promise<PluginRecord | null> {
  const { rows } = await db.unsafe<PluginRecordRow>(
    `select ${RECORD_COLUMNS} from plugin_records
     where plugin_id = ${placeholder(db.dialect, 1)} and resource_id = ${placeholder(db.dialect, 2)} and unique_key = ${placeholder(db.dialect, 3)}`,
    [scope.pluginId, scope.resourceId, uniqueKey],
  )
  return rows[0] ? mapPluginRecord(rows[0]) : null
}

/**
 * Replace a record's data and bump its version. With `ifVersion` the update
 * applies only while the stored version still matches, in the same statement,
 * so two writers that read the same version cannot both win.
 *
 * Returns null when the record does not exist. Throws
 * `PluginRecordConflictError` when `ifVersion` no longer matches and
 * `PluginRecordDuplicateError` when the new key belongs to another record.
 */
export async function updatePluginRecord(
  db: DbClient,
  input: RecordWrite & { ifVersion?: number },
): Promise<PluginRecord | null> {
  assertStorableRecordData(input.data)
  const params: unknown[] = [
    input.data,
    input.uniqueKey,
    nowIso(),
    input.id,
    input.pluginId,
    input.resourceId,
  ]
  let versionGuard = ''
  if (input.ifVersion !== undefined) {
    params.push(input.ifVersion)
    versionGuard = ` and version = ${placeholder(db.dialect, params.length)}`
  }
  let rows: PluginRecordRow[]
  try {
    const result = await db.unsafe<PluginRecordRow>(
      `update plugin_records
          set data_json = ${placeholder(db.dialect, 1)},
              unique_key = ${placeholder(db.dialect, 2)},
              version = version + 1,
              updated_at = ${placeholder(db.dialect, 3)}
        where id = ${placeholder(db.dialect, 4)} and plugin_id = ${placeholder(db.dialect, 5)} and resource_id = ${placeholder(db.dialect, 6)}${versionGuard}
        returning ${RECORD_COLUMNS}`,
      params,
    )
    rows = result.rows
  } catch (err) {
    if (input.uniqueKey !== null && isUniqueViolation(err)) {
      throw new PluginRecordDuplicateError(input.uniqueKey)
    }
    throw err
  }
  if (rows[0]) return mapPluginRecord(rows[0])
  if (input.ifVersion === undefined) return null
  const current = await getPluginRecord(db, input, input.id)
  if (!current) return null
  throw new PluginRecordConflictError(current.version)
}

/**
 * Delete a record. With `ifVersion` it is deleted only while the stored
 * version still matches; a mismatch throws `PluginRecordConflictError`.
 */
export async function deletePluginRecord(
  db: DbClient,
  input: RecordScope & { id: string; ifVersion?: number },
): Promise<boolean> {
  const params: unknown[] = [input.id, input.pluginId, input.resourceId]
  let versionGuard = ''
  if (input.ifVersion !== undefined) {
    params.push(input.ifVersion)
    versionGuard = ` and version = ${placeholder(db.dialect, params.length)}`
  }
  const { rows } = await db.unsafe<{ id: string }>(
    `delete from plugin_records
      where id = ${placeholder(db.dialect, 1)} and plugin_id = ${placeholder(db.dialect, 2)} and resource_id = ${placeholder(db.dialect, 3)}${versionGuard}
      returning id`,
    params,
  )
  if (rows.length > 0) return true
  if (input.ifVersion === undefined) return false
  const current = await getPluginRecord(db, input, input.id)
  if (!current) return false
  throw new PluginRecordConflictError(current.version)
}

// ---------------------------------------------------------------------------
// Re-keying — when a plugin's declaration of a resource's `uniqueField`
// changes (added, changed, removed, or the resource is declared for the
// first time), the stored keys must follow it.
// ---------------------------------------------------------------------------

/** Most records one resource may hold for its keys to be rebuilt in one go. */
export const PLUGIN_RECORD_REKEY_LIMIT = 50_000

/** Existing records cannot take the keys the new `uniqueField` asks for. */
export class PluginRecordRekeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginRecordRekeyError'
  }
}

/**
 * Work out the key every record of a resource would take from `uniqueField`,
 * derived exactly as a write derives it. Throws `PluginRecordRekeyError` when
 * two records share a value, a value is too long, or the resource is too
 * large to rebuild in one go.
 */
async function planPluginRecordKeys(
  db: DbClient,
  scope: RecordScope,
  uniqueField: string,
): Promise<Array<{ id: string; uniqueKey: string }>> {
  const { rows } = await db.unsafe<Pick<PluginRecordRow, 'id' | 'data_json'>>(
    `select id, data_json from plugin_records
     where plugin_id = ${placeholder(db.dialect, 1)} and resource_id = ${placeholder(db.dialect, 2)}
     limit ${PLUGIN_RECORD_REKEY_LIMIT + 1}`,
    [scope.pluginId, scope.resourceId],
  )
  if (rows.length > PLUGIN_RECORD_REKEY_LIMIT) {
    throw new PluginRecordRekeyError(
      `"${scope.resourceId}" holds more than ${PLUGIN_RECORD_REKEY_LIMIT} records, too many to give a unique field in one go.`,
    )
  }
  const seen = new Set<string>()
  const plan: Array<{ id: string; uniqueKey: string }> = []
  for (const row of rows) {
    let uniqueKey: string | null
    try {
      uniqueKey = deriveRecordUniqueKey(readDataJson(row)[uniqueField])
    } catch (err) {
      throw new PluginRecordRekeyError(
        `A "${scope.resourceId}" record cannot take "${uniqueField}" as its key: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (uniqueKey === null) continue
    if (seen.has(uniqueKey)) {
      throw new PluginRecordRekeyError(
        `Two "${scope.resourceId}" records share the "${uniqueField}" value "${uniqueKey.slice(0, 80)}", so it cannot become the unique field.`,
      )
    }
    seen.add(uniqueKey)
    plan.push({ id: row.id, uniqueKey })
  }
  return plan
}

/** Why the resource's records cannot take `uniqueField` as their key, or null. */
export async function pluginRecordRekeyProblem(
  db: DbClient,
  scope: RecordScope,
  uniqueField: string,
): Promise<string | null> {
  try {
    await planPluginRecordKeys(db, scope, uniqueField)
    return null
  } catch (err) {
    if (err instanceof PluginRecordRekeyError) return err.message
    throw err
  }
}

/**
 * Make a resource's stored keys match its declaration: rebuilt from
 * `uniqueField`, or cleared when the resource has none. Record versions are
 * left alone (the data did not change).
 *
 * Several statements with no transaction of their own: call it on the `tx`
 * of the transaction that also writes the manifest declaring the field, so
 * the declaration and the keys change together or not at all.
 */
export async function rekeyPluginRecords(
  tx: DbClient,
  scope: RecordScope,
  uniqueField: string | undefined,
): Promise<void> {
  await tx.unsafe(
    `update plugin_records set unique_key = null
      where plugin_id = ${placeholder(tx.dialect, 1)} and resource_id = ${placeholder(tx.dialect, 2)} and unique_key is not null`,
    [scope.pluginId, scope.resourceId],
  )
  if (uniqueField === undefined) return
  for (const { id, uniqueKey } of await planPluginRecordKeys(tx, scope, uniqueField)) {
    await tx.unsafe(
      `update plugin_records set unique_key = ${placeholder(tx.dialect, 1)} where id = ${placeholder(tx.dialect, 2)}`,
      [uniqueKey, id],
    )
  }
}
