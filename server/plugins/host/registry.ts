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
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'
import type { ContentAccessMode } from '@core/plugin-sdk/contentSchemas'
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
 * Authoritative check for `api.cms.content.*` table access. Each handler
 * runs this BEFORE any repository call so a plugin that holds the
 * permission but didn't list the table (or list the right mode) in its
 * manifest's `contentAccess[]` fails closed.
 */
export function assertContentTableAccess(
  entry: HostPluginRecord,
  tableSlug: string,
  mode: ContentAccessMode,
): void {
  const access = entry.manifest.contentAccess ?? []
  const found = access.find((row) => row.table === tableSlug)
  if (!found) {
    throw new Error(
      `Plugin "${entry.manifest.id}" does not have contentAccess declared for table "${tableSlug}"`,
    )
  }
  if (!found.modes.includes(mode)) {
    throw new Error(
      `Plugin "${entry.manifest.id}" has contentAccess for table "${tableSlug}" but not for mode "${mode}"`,
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
