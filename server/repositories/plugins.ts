import type {
  InstalledPlugin,
  PluginLifecycleStatus,
  PluginManifest,
  PluginPermission,
  PluginRecord,
} from '@core/plugin-sdk'
import { pluginSettingsDefaults } from '@core/plugin-sdk'
import type { StorageListOptions, StorageFilterOperator } from '@core/plugin-sdk/storageSchemas'
import { parsePluginManifest } from '@core/plugins/manifest'
import type { DbClient, Dialect } from '../db/client'
import { isoDate } from '@core/utils/isoDate'
import { jsonField } from '../db/jsonExtract'

/**
 * Discriminated union returned by every repository function that reads an
 * installed-plugin row and needs to parse the stored `manifest_json`.
 *
 * `kind: 'ok'`     — manifest parsed successfully; `plugin` is fully typed.
 * `kind: 'broken'` — manifest_json is corrupt or fails validation; the row
 *                    still exists in the DB. `id`, `name`, `version` come
 *                    from the row's own columns (written at install time and
 *                    never derived from manifest_json), so they are reliable
 *                    even when the manifest payload cannot be parsed.
 *                    `reason` is the message from the parse error.
 */
export type InstalledPluginResult =
  | { kind: 'ok'; plugin: InstalledPlugin }
  | { kind: 'broken'; id: string; name: string; version: string; rawManifest: unknown; reason: string }

interface InstalledPluginRow {
  id: string
  name: string
  version: string
  enabled: boolean
  lifecycle_status?: string | null
  last_error?: string | null
  granted_permissions_json?: unknown
  manifest_json: unknown
  settings_json?: unknown
  installed_at: Date | string
  updated_at: Date | string
}

interface PluginRecordRow {
  id: string
  plugin_id: string
  resource_id: string
  data_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

// Returns unknown by design — every caller validates downstream via
// parsePluginManifest (TypeBox) or readPermissionGrants. Safe boundary.
function readManifestJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function writeJson(value: unknown): string {
  return JSON.stringify(value)
}

function mapInstalledPlugin(row: InstalledPluginRow): InstalledPluginResult {
  const rawManifest = readManifestJson(row.manifest_json)
  try {
    const manifest = parsePluginManifest(rawManifest)
    const grantedPermissions = readManifestJson(row.granted_permissions_json)
    const lifecycleStatus = readLifecycleStatus(row.lifecycle_status, Boolean(row.enabled))
    const storedSettings = readManifestJson(row.settings_json)
    const settings = mergeSettingsWithDefaults(manifest, storedSettings)
    return {
      kind: 'ok',
      plugin: {
        id: row.id,
        name: row.name,
        version: row.version,
        enabled: Boolean(row.enabled),
        lifecycleStatus,
        lastError: row.last_error ?? null,
        grantedPermissions: Array.isArray(grantedPermissions)
          ? grantedPermissions as PluginPermission[]
          : manifest.grantedPermissions ?? [],
        manifest,
        settings,
        installedAt: isoDate(row.installed_at),
        updatedAt: isoDate(row.updated_at),
      },
    }
  } catch (err) {
    return {
      kind: 'broken',
      id: row.id,
      name: row.name,
      version: row.version,
      rawManifest,
      reason: err instanceof Error ? err.message : 'Invalid plugin manifest',
    }
  }
}

/**
 * Merge stored values with the manifest's declared defaults. Ensures every
 * declared setting key has a value (defaults populated on read), and drops
 * stored keys that the current manifest doesn't declare (cleans up orphans
 * after a plugin update removes a setting).
 */
function mergeSettingsWithDefaults(
  manifest: PluginManifest,
  stored: unknown,
): Record<string, string | number | boolean> {
  const declared = manifest.settings ?? []
  const defaults = pluginSettingsDefaults(declared)
  const out: Record<string, string | number | boolean> = { ...defaults }
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const declaredIds = new Set(declared.map((s) => s.id))
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!declaredIds.has(key)) continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value
      }
    }
  }
  return out
}

function readLifecycleStatus(value: unknown, enabled: boolean): PluginLifecycleStatus {
  if (
    value === 'installed' ||
    value === 'active' ||
    value === 'disabled' ||
    value === 'error'
  ) {
    return value
  }
  return enabled ? 'active' : 'disabled'
}

function mapPluginRecord(row: PluginRecordRow): PluginRecord {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    resourceId: row.resource_id,
    data: readManifestJson(row.data_json) as Record<string, unknown>,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  }
}

export async function listInstalledPlugins(db: DbClient): Promise<InstalledPluginResult[]> {
  const { rows } = await db<InstalledPluginRow>`
    select id, name, version, enabled, lifecycle_status, last_error,
           granted_permissions_json, manifest_json, settings_json, installed_at, updated_at
    from installed_plugins
    order by installed_at desc
  `
  return rows.map(mapInstalledPlugin)
}

export async function getInstalledPlugin(db: DbClient, id: string): Promise<InstalledPluginResult | null> {
  const { rows } = await db<InstalledPluginRow>`
    select id, name, version, enabled, lifecycle_status, last_error,
           granted_permissions_json, manifest_json, settings_json, installed_at, updated_at
    from installed_plugins
    where id = ${id}
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

export async function installPlugin(
  db: DbClient,
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[] = manifest.grantedPermissions ?? [],
): Promise<InstalledPlugin> {
  const manifestToStore = { ...manifest, grantedPermissions }
  // Seed settings with the manifest's declared defaults so plugins reading
  // their own settings on first activate see a complete record.
  const initialSettings = pluginSettingsDefaults(manifest.settings ?? [])
  const { rows } = await db<InstalledPluginRow>`
    insert into installed_plugins (id, name, version, manifest_json, granted_permissions_json, settings_json, enabled, lifecycle_status, last_error)
    values (${manifest.id}, ${manifest.name}, ${manifest.version}, ${writeJson(manifestToStore)}, ${writeJson(grantedPermissions)}, ${writeJson(initialSettings)}, true, 'installed', null)
    on conflict (id) do update
      set name = excluded.name,
          version = excluded.version,
          manifest_json = excluded.manifest_json,
          granted_permissions_json = excluded.granted_permissions_json,
          enabled = true,
          lifecycle_status = 'installed',
          last_error = null,
          updated_at = current_timestamp
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, settings_json, installed_at, updated_at
  `
  const result = mapInstalledPlugin(rows[0])
  // installPlugin is always called with a freshly-validated manifest — a
  // broken result here indicates a serialisation invariant violation.
  if (result.kind !== 'ok') {
    throw new Error(`[plugins] Failed to re-parse just-installed manifest for "${manifest.id}": ${result.reason}`)
  }
  return result.plugin
}

export async function setPluginEnabled(
  db: DbClient,
  id: string,
  enabled: boolean,
): Promise<InstalledPluginResult | null> {
  const { rows } = await db<InstalledPluginRow>`
    update installed_plugins set enabled = ${enabled}, updated_at = current_timestamp
    where id = ${id}
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, settings_json, installed_at, updated_at
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

export async function setPluginLifecycleStatus(
  db: DbClient,
  id: string,
  lifecycleStatus: PluginLifecycleStatus,
  lastError: string | null = null,
): Promise<InstalledPluginResult | null> {
  const { rows } = await db<InstalledPluginRow>`
    update installed_plugins set lifecycle_status = ${lifecycleStatus}, last_error = ${lastError}, updated_at = current_timestamp
    where id = ${id}
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, settings_json, installed_at, updated_at
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

export async function deletePlugin(db: DbClient, id: string): Promise<boolean> {
  const { rowCount } = await db`delete from installed_plugins where id = ${id}`
  return rowCount > 0
}

export async function setPluginSettings(
  db: DbClient,
  id: string,
  settings: Record<string, string | number | boolean>,
): Promise<InstalledPluginResult | null> {
  const { rows } = await db<InstalledPluginRow>`
    update installed_plugins
       set settings_json = ${writeJson(settings)},
           updated_at = current_timestamp
     where id = ${id}
    returning id, name, version, enabled, lifecycle_status, last_error,
              granted_permissions_json, manifest_json, settings_json, installed_at, updated_at
  `
  return rows[0] ? mapInstalledPlugin(rows[0]) : null
}

/** Identifier regex — same rule as the jsonField() helper. */
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Build a dialect-appropriate positional parameter placeholder. */
function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?'
}

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
    select id, plugin_id, resource_id, data_json, created_at, updated_at
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

export async function createPluginRecord(
  db: DbClient,
  input: {
    id: string
    pluginId: string
    resourceId: string
    data: Record<string, unknown>
  },
): Promise<PluginRecord> {
  const { rows } = await db<PluginRecordRow>`
    insert into plugin_records (id, plugin_id, resource_id, data_json)
    values (${input.id}, ${input.pluginId}, ${input.resourceId}, ${writeJson(input.data)})
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
  const { rows } = await db<PluginRecordRow>`
    update plugin_records set data_json = ${writeJson(input.data)}, updated_at = current_timestamp
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

// ---------------------------------------------------------------------------
// Plugin crash events — persisted history of plugin worker crashes so the
// admin UI can show "Recent issues" for each plugin without operators
// having to read server stdout. Capped at MAX_CRASH_EVENTS_PER_PLUGIN per
// plugin id (rolling window) to bound DB growth.
// ---------------------------------------------------------------------------

const MAX_CRASH_EVENTS_PER_PLUGIN = 50

export interface PluginCrashEvent {
  id: string
  pluginId: string
  occurredAt: string
  reason: string
  stack: string | null
}

interface PluginCrashEventRow {
  id: string
  plugin_id: string
  occurred_at: Date | string
  reason: string
  stack: string | null
}

function mapPluginCrashEvent(row: PluginCrashEventRow): PluginCrashEvent {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    occurredAt: isoDate(row.occurred_at),
    reason: row.reason,
    stack: row.stack ?? null,
  }
}

/** Insert a new crash event row + prune older rows past the cap. */
export async function recordPluginCrash(
  db: DbClient,
  input: { id: string; pluginId: string; reason: string; stack?: string | null },
): Promise<PluginCrashEvent> {
  const { rows } = await db<PluginCrashEventRow>`
    insert into plugin_crash_events (id, plugin_id, reason, stack)
    values (${input.id}, ${input.pluginId}, ${input.reason}, ${input.stack ?? null})
    returning id, plugin_id, occurred_at, reason, stack
  `

  // Roll the window — keep only the N most recent events for this plugin.
  // Done as a separate statement (not a CTE) to stay dialect-naive: ANSI
  // SQL guarantees this works on both PG and SQLite.
  await db`
    delete from plugin_crash_events
    where plugin_id = ${input.pluginId}
      and id not in (
        select id from plugin_crash_events
        where plugin_id = ${input.pluginId}
        order by occurred_at desc
        limit ${MAX_CRASH_EVENTS_PER_PLUGIN}
      )
  `
  return mapPluginCrashEvent(rows[0])
}

/** List the most-recent crash events for one plugin, newest first. */
export async function listPluginCrashes(
  db: DbClient,
  pluginId: string,
  limit = MAX_CRASH_EVENTS_PER_PLUGIN,
): Promise<PluginCrashEvent[]> {
  const { rows } = await db<PluginCrashEventRow>`
    select id, plugin_id, occurred_at, reason, stack
    from plugin_crash_events
    where plugin_id = ${pluginId}
    order by occurred_at desc
    limit ${limit}
  `
  return rows.map(mapPluginCrashEvent)
}

/** Drop every crash event for a plugin. Called on uninstall + on manual restart. */
export async function clearPluginCrashes(db: DbClient, pluginId: string): Promise<void> {
  await db`delete from plugin_crash_events where plugin_id = ${pluginId}`
}
