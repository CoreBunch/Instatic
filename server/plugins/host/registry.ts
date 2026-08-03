/**
 * Plugin host registry — the shared mutable state for loaded plugins.
 *
 * `hostPlugins` is the source of truth for what the main process knows about
 * each active plugin: routes, hook registrations, loop sources, media
 * adapters, and in-flight fetches. All dispatch paths read from here.
 *
 * `dbForApi` is injected by the server startup sequence once the database
 * client is ready, so api-call dispatch can reach repositories without
 * importing the db client at module load time.
 */

import type { DbClient } from '../../db/client'
import type { DataTable } from '@core/data/schemas'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'
import { OWN_CREATED_TABLES_MARKER, type ContentAccessEntry, type ContentAccessMode } from '@core/plugin-sdk/contentSchemas'
import type { HostPluginRecord } from './types'

export const hostPlugins = new Map<string, HostPluginRecord>()

function hasGrantedPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return new Set(manifest.grantedPermissions ?? []).has(permission)
}

export function assertHostPluginPermission(
  entry: HostPluginRecord,
  permission: PluginPermission,
): void {
  if (!hasGrantedPermission(entry.manifest, permission)) {
    throw new Error(`Plugin "${entry.manifest.id}" requires permission "${permission}"`)
  }
}

/**
 * Every manifest `contentAccess[]` entry that covers `table`. Two match forms:
 *
 *   - a slug entry (`{ table: 'posts' }`) matches by exact slug;
 *   - the `@own-created` marker matches any table whose `createdByPluginId`
 *     is this plugin — the durable creator record written by
 *     `cms.content.tables.create` — so importer/migration plugins can reach
 *     tables whose names only exist at runtime.
 *
 * Marker entries never match by slug, so even a table literally slugged
 * `@own-created` is only ever reachable by its creator (and no static entry
 * can name it — the manifest slug pattern requires a leading letter).
 */
function matchingContentAccessEntries(
  manifest: PluginManifest,
  table: DataTable,
): ContentAccessEntry[] {
  return (manifest.contentAccess ?? []).filter((row) =>
    row.table === OWN_CREATED_TABLES_MARKER
      ? table.createdByPluginId === manifest.id
      : row.table === table.slug,
  )
}

/**
 * Whether `table` is covered by any `contentAccess[]` entry, regardless of
 * mode. Drives result filtering in `tables.list` / `search`, which show
 * every declared table (same as always — mode narrowing applies to the
 * per-table operations, not to list membership).
 */
export function hasContentTableAccess(
  manifest: PluginManifest,
  table: DataTable,
): boolean {
  return matchingContentAccessEntries(manifest, table).length > 0
}

/**
 * Authoritative check for `api.cms.content.*` table access. Each handler
 * runs this on the RESOLVED table before any repository read/write, so a
 * plugin that holds the permission but didn't cover the table (or the
 * mode) in its manifest's `contentAccess[]` fails closed. Entries combine
 * as a union: the operation is allowed when ANY matching entry declares
 * the mode.
 */
export function assertContentTableAccess(
  entry: HostPluginRecord,
  table: DataTable,
  mode: ContentAccessMode,
): void {
  const matches = matchingContentAccessEntries(entry.manifest, table)
  if (matches.length === 0) {
    throw new Error(
      `Plugin "${entry.manifest.id}" does not have contentAccess declared for table "${table.slug}"`,
    )
  }
  if (!matches.some((row) => row.modes.includes(mode))) {
    throw new Error(
      `Plugin "${entry.manifest.id}" has contentAccess for table "${table.slug}" but not for mode "${mode}"`,
    )
  }
}

let dbForApi: DbClient | null = null

export function setPluginWorkerDbClient(db: DbClient): void {
  dbForApi = db
}

export function getDbForApi(): DbClient | null {
  return dbForApi
}
