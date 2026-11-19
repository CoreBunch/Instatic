/**
 * Plugin-owned records (`plugin_records`): the storage behind
 * `api.cms.storage.collection(...)` and the admin resource pages.
 *
 * Plugin handlers interleave (one worker per plugin per process, one worker
 * per server instance), so every write here is a single statement whose
 * outcome the database decides: "create if absent" rides the unique index on
 * `(plugin_id, resource_id, unique_key)`, and a conditional update compares
 * `version` in its WHERE clause. Nothing reads first and writes second.
 */
import { STORAGE_UNIQUE_KEY_MAX_LENGTH, type PluginRecord } from '@core/plugin-sdk'
import type { StorageListOptions, StorageFilterOperator } from '@core/plugin-sdk/storageSchemas'
import { isoDate, nowIso } from '@core/utils/isoDate'
import { placeholder, type DbClient } from '../db/client'
import { isUniqueViolation } from '../db/errors'
import { jsonField } from '../db/jsonExtract'

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
function readDataJson(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function mapPluginRecord(row: PluginRecordRow): PluginRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    resourceId: row.resource_id,
    data: readDataJson(row.data_json),
    uniqueKey: row.unique_key,
    version: Number(row.version),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

/** Identifier regex — same rule as the jsonField() helper. */
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export async function listPluginRecords(
  db: DbClient,
  pluginId: string,
  resourceId: string,
  options: StorageListOptions = {},
): Promise<{ records: PluginRecord[]; totalCount: number }> {
  const { filter, orderBy, limit = 100, offset = 0 } = options

  const params: unknown[] = [pluginId, resourceId]
  let paramIdx = 2

  // Returns the next positional placeholder AND appends the value to params.
  function addParam(value: unknown): string {
    params.push(value)
    paramIdx++
    return placeholder(db.dialect, paramIdx)
  }

  // --- WHERE clause ---
  let whereSql = `plugin_id = ${placeholder(db.dialect, 1)} and resource_id = ${placeholder(db.dialect, 2)}`

  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[plugin:storage] invalid filter field name: ${JSON.stringify(key)}`)
      }
      const fragment = jsonField('data_json', key, db.dialect).sql

      if (value === null || typeof value !== 'object') {
        // Shorthand primitive — treat as eq
        whereSql += ` and ${fragment} = ${addParam(value)}`
      } else {
        // Full operator object
        const op = value as StorageFilterOperator
        if (op.eq !== undefined) {
          whereSql += ` and ${fragment} = ${addParam(op.eq)}`
        }
        if (op.ne !== undefined) {
          whereSql += ` and ${fragment} != ${addParam(op.ne)}`
        }
        if (op.gt !== undefined) {
          whereSql += ` and ${fragment} > ${addParam(op.gt)}`
        }
        if (op.gte !== undefined) {
          whereSql += ` and ${fragment} >= ${addParam(op.gte)}`
        }
        if (op.lt !== undefined) {
          whereSql += ` and ${fragment} < ${addParam(op.lt)}`
        }
        if (op.lte !== undefined) {
          whereSql += ` and ${fragment} <= ${addParam(op.lte)}`
        }
        if (op.in !== undefined) {
          if (op.in.length === 0) {
            // Empty IN list — no rows can ever match
            whereSql += ` and 1=0`
          } else {
            const inPlaceholders: string[] = op.in.map((v) => addParam(v))
            whereSql += ` and ${fragment} in (${inPlaceholders.join(', ')})`
          }
        }
        if (op.like !== undefined) {
          whereSql += ` and lower(${fragment}) like lower(${addParam(op.like)})`
        }
      }
    }
  }

  // Snapshot how many params the WHERE clause uses (for count query).
  const countParamCount = params.length

  // --- ORDER BY clause ---
  let orderBySql = 'created_at desc'
  if (orderBy && Object.keys(orderBy).length > 0) {
    const parts: string[] = []
    for (const [key, dir] of Object.entries(orderBy)) {
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[plugin:storage] invalid orderBy field name: ${JSON.stringify(key)}`)
      }
      const fragment = jsonField('data_json', key, db.dialect).sql
      parts.push(`${fragment} ${dir}`)
    }
    orderBySql = parts.join(', ')
  }

  // --- LIMIT / OFFSET (appended after count params are captured) ---
  const limitPlaceholder = addParam(limit)
  const offsetPlaceholder = addParam(offset)

  const dataSql = `
    select ${RECORD_COLUMNS}
    from plugin_records
    where ${whereSql}
    order by ${orderBySql}
    limit ${limitPlaceholder} offset ${offsetPlaceholder}
  `

  const countSql = `
    select count(*) as total
    from plugin_records
    where ${whereSql}
  `

  const dataParams = params
  const countParams = params.slice(0, countParamCount)

  const [dataResult, countResult] = await Promise.all([
    db.unsafe<PluginRecordRow>(dataSql, dataParams),
    db.unsafe<{ total: number | bigint | string }>(countSql, countParams),
  ])

  const totalCount = Number(countResult.rows[0]?.total ?? 0)

  return {
    records: dataResult.rows.map(mapPluginRecord),
    totalCount,
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
// Re-keying — when a plugin upgrade adds, changes or removes a resource's
// `uniqueField`, the stored keys must follow the new declaration.
// ---------------------------------------------------------------------------

/** Most records one resource may hold for its keys to be rebuilt in an upgrade. */
export const PLUGIN_RECORD_REKEY_LIMIT = 50_000

/** Existing records cannot take the keys the new `uniqueField` asks for. */
export class PluginRecordRekeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PluginRecordRekeyError'
  }
}

/**
 * Work out the key every record of a resource would take from `uniqueField`.
 * Throws `PluginRecordRekeyError` when two records share a value, a value is
 * too long, or the resource is too large to rebuild in one go.
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
      `"${scope.resourceId}" holds more than ${PLUGIN_RECORD_REKEY_LIMIT} records, too many to give a unique field in an upgrade.`,
    )
  }
  const seen = new Set<string>()
  const plan: Array<{ id: string; uniqueKey: string }> = []
  for (const row of rows) {
    const value = readDataJson(row.data_json)[uniqueField]
    if (typeof value !== 'string' || value === '') continue
    if (value.length > STORAGE_UNIQUE_KEY_MAX_LENGTH) {
      throw new PluginRecordRekeyError(
        `A "${scope.resourceId}" record holds a "${uniqueField}" longer than ${STORAGE_UNIQUE_KEY_MAX_LENGTH} characters.`,
      )
    }
    if (seen.has(value)) {
      throw new PluginRecordRekeyError(
        `Two "${scope.resourceId}" records share the "${uniqueField}" value "${value.slice(0, 80)}", so it cannot become the unique field.`,
      )
    }
    seen.add(value)
    plan.push({ id: row.id, uniqueKey: value })
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
 * `uniqueField`, or cleared when the resource no longer has one. One
 * transaction; record versions are left alone (the data did not change).
 */
export async function rekeyPluginRecords(
  db: DbClient,
  scope: RecordScope,
  uniqueField: string | undefined,
): Promise<void> {
  await db.transaction(async (tx) => {
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
  })
}
