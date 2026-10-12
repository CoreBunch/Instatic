import type { DbClient } from '../db/client'

export type PluginRedirectStatus = 301 | 302 | 307 | 308 | 410
export const PLUGIN_REDIRECT_STATUSES: readonly PluginRedirectStatus[] = [301, 302, 307, 308, 410]
export const PLUGIN_REDIRECTS_MAX_PER_PLUGIN = 5000
export const PLUGIN_REDIRECT_MAX_LENGTH = 2048

export interface PluginRedirectInput {
  fromPath: string
  toLocation: string | null
  status: PluginRedirectStatus
}

export interface PluginRedirectRow {
  pluginId: string
  fromPath: string
  toLocation: string | null
  status: PluginRedirectStatus
  createdAt: string
  updatedAt: string
}

export class PluginRedirectValidationError extends Error {
  readonly field: 'fromPath' | 'toLocation' | 'status' | 'limit'

  constructor(field: PluginRedirectValidationError['field'], message: string) {
    super(message)
    this.name = 'PluginRedirectValidationError'
    this.field = field
  }
}

function hasWhitespaceOrControl(value: string): boolean {
  return /\s/u.test(value) || [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159)
  })
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

/** Normalize the exact, case-sensitive source pathname without decoding it. */
export function normalizeRedirectFromPath(raw: string): string {
  if (typeof raw === 'string' && [...raw].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) > 126)) {
    throw new PluginRedirectValidationError('fromPath', 'Must contain only printable ASCII; percent-encode other characters (e.g. /caf%C3%A9)')
  }
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')
    || raw.includes('?') || raw.includes('#') || hasWhitespaceOrControl(raw)
    || raw.length > PLUGIN_REDIRECT_MAX_LENGTH) {
    throw new PluginRedirectValidationError('fromPath', 'Must be a path starting with /, without query, fragment, whitespace or control characters, at most 2048 characters')
  }
  const fromPath = stripTrailingSlash(raw)
  if (['/admin', '/_instatic', '/uploads'].some((prefix) => fromPath === prefix || fromPath.startsWith(`${prefix}/`))) {
    throw new PluginRedirectValidationError('fromPath', 'Reserved path prefix')
  }
  return fromPath
}

export function validatePluginRedirectInput(input: PluginRedirectInput): PluginRedirectInput {
  const fromPath = normalizeRedirectFromPath(input.fromPath)
  if (!PLUGIN_REDIRECT_STATUSES.includes(input.status)) {
    throw new PluginRedirectValidationError('status', 'Must be 301, 302, 307, 308 or 410')
  }
  if (input.status === 410) {
    if (input.toLocation != null) {
      throw new PluginRedirectValidationError('toLocation', 'Must be absent or null for status 410')
    }
    return { fromPath, toLocation: null, status: input.status }
  }
  const toLocation = input.toLocation
  if (typeof toLocation !== 'string' || toLocation.length === 0
    || toLocation.length > PLUGIN_REDIRECT_MAX_LENGTH || hasWhitespaceOrControl(toLocation)) {
    throw new PluginRedirectValidationError('toLocation', 'Required, without whitespace or control characters, at most 2048 characters')
  }
  if (toLocation.startsWith('/') && !toLocation.startsWith('//') && !toLocation.startsWith('/\\')) {
    if (stripTrailingSlash(toLocation) === fromPath) {
      throw new PluginRedirectValidationError('toLocation', 'Must not equal the normalized fromPath')
    }
  } else {
    let target: URL
    try {
      target = new URL(toLocation)
    } catch (_err) {
      // Invalid URL syntax is a field validation failure.
      throw new PluginRedirectValidationError('toLocation', 'Must be a path starting with / or an absolute http: or https: URL')
    }
    if (!/^https?:\/\//i.test(toLocation) || !['http:', 'https:'].includes(target.protocol)) {
      throw new PluginRedirectValidationError('toLocation', 'Must be a path starting with / or an absolute http: or https: URL')
    }
  }
  return { fromPath, toLocation, status: input.status }
}

interface StoredRedirectRow {
  plugin_id: string
  from_path: string
  to_location: string | null
  status: PluginRedirectStatus
  created_at: string
  updated_at: string
}

function mapRow(row: StoredRedirectRow): PluginRedirectRow {
  return {
    pluginId: row.plugin_id,
    fromPath: row.from_path,
    toLocation: row.to_location,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function setPluginRedirect(db: DbClient, pluginId: string, input: PluginRedirectInput): Promise<PluginRedirectRow> {
  const rule = validatePluginRedirectInput(input)
  return db.transaction(async (tx) => {
    await lockPluginRedirectWrites(tx, pluginId)
    const { rows } = await tx<{ count: number }>`
      select count(*) as count from plugin_redirects
        where plugin_id = ${pluginId} and from_path <> ${rule.fromPath}
    `
    if (Number(rows[0]!.count) >= PLUGIN_REDIRECTS_MAX_PER_PLUGIN) {
      throw new PluginRedirectValidationError('limit', 'At most 5000 rules per plugin')
    }
    return writePluginRedirect(tx, pluginId, rule)
  })
}

async function lockPluginRedirectWrites(db: DbClient, pluginId: string): Promise<void> {
  // A no-op owner-row update serializes set/replace across Postgres connections;
  // SQLite serializes transactions in its adapter. Both use the same SQL.
  await db`update installed_plugins set id = id where id = ${pluginId}`
}

async function writePluginRedirect(db: DbClient, pluginId: string, rule: PluginRedirectInput): Promise<PluginRedirectRow> {
  const nowIso = new Date().toISOString()
  const { rows } = await db<StoredRedirectRow>`
    insert into plugin_redirects (plugin_id, from_path, to_location, status, created_at, updated_at)
    values (${pluginId}, ${rule.fromPath}, ${rule.toLocation}, ${rule.status}, ${nowIso}, ${nowIso})
    on conflict (plugin_id, from_path) do update set
      to_location = excluded.to_location,
      status = excluded.status,
      updated_at = excluded.updated_at
    returning plugin_id, from_path, to_location, status, created_at, updated_at
  `
  return mapRow(rows[0]!)
}

export async function replacePluginRedirects(db: DbClient, pluginId: string, inputs: PluginRedirectInput[]): Promise<{ count: number }> {
  if (inputs.length > PLUGIN_REDIRECTS_MAX_PER_PLUGIN) {
    throw new PluginRedirectValidationError('limit', 'At most 5000 rules per plugin')
  }
  const rules = new Map<string, PluginRedirectInput>()
  for (const input of inputs) {
    const rule = validatePluginRedirectInput(input)
    rules.set(rule.fromPath, rule)
  }
  return db.transaction(async (tx) => {
    await lockPluginRedirectWrites(tx, pluginId)
    await tx`delete from plugin_redirects where plugin_id = ${pluginId}`
    for (const rule of rules.values()) await writePluginRedirect(tx, pluginId, rule)
    return { count: rules.size }
  })
}

export async function deletePluginRedirect(db: DbClient, pluginId: string, fromPath: string): Promise<boolean> {
  let normalized: string
  try {
    normalized = normalizeRedirectFromPath(fromPath)
  } catch (err) {
    if (err instanceof PluginRedirectValidationError) return false
    throw err
  }
  const { rowCount } = await db`
    delete from plugin_redirects where plugin_id = ${pluginId} and from_path = ${normalized}
  `
  return rowCount > 0
}

export async function listPluginRedirects(db: DbClient, pluginId: string): Promise<PluginRedirectRow[]> {
  const { rows } = await db<StoredRedirectRow>`
    select plugin_id, from_path, to_location, status, created_at, updated_at
      from plugin_redirects where plugin_id = ${pluginId} order by from_path asc
  `
  return rows.map(mapRow)
}

export async function findPluginRedirect(db: DbClient, pathname: string): Promise<PluginRedirectRow | null> {
  let fromPath: string
  try {
    fromPath = normalizeRedirectFromPath(pathname)
  } catch (err) {
    if (err instanceof PluginRedirectValidationError) return null
    throw err
  }
  const { rows } = await db<StoredRedirectRow>`
    select plugin_id, from_path, to_location, status, created_at, updated_at
      from plugin_redirects where from_path = ${fromPath}
      order by created_at asc, plugin_id asc limit 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}
