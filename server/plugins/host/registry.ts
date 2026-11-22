/**
 * Plugin host registry — the shared mutable state for loaded plugins.
 *
 * `hostPlugins` is the source of truth for what the main process knows about
 * each active plugin: routes, hook registrations, loop sources, media
 * adapters, and in-flight fetches. All dispatch paths read from here.
 *
 * `hostContext` (the database client and the uploads directory) is injected by
 * the server startup sequence, so api-call dispatch can reach repositories and
 * the baked publish slot without importing either at module load time.
 */

import type { DbClient } from '../../db/client'
import type { DataTable } from '@core/data/schemas'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'
import {
  CONTENT_ACCESS_MODE_PERMISSIONS,
  OWN_CREATED_TABLES_MARKER,
  type ContentAccessEntry,
  type ContentAccessMode,
} from '@core/plugin-sdk/contentSchemas'
import { isInPluginNamespace, owningPluginId } from '@core/plugins/namespaceOwnership'
import { listInstalledPluginIds } from '../../repositories/plugins'
import type { HostPluginRecord } from './types'

export const hostPlugins = new Map<string, HostPluginRecord>()

function hasGrantedPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return new Set(manifest.grantedPermissions ?? []).has(permission)
}

/** Whether the plugin was granted a permission. Unknown plugins hold none. */
export function hostPluginHasPermission(pluginId: string, permission: PluginPermission): boolean {
  return (hostPlugins.get(pluginId)?.manifest.grantedPermissions ?? []).includes(permission)
}

export function assertHostPluginPermission(
  entry: HostPluginRecord,
  permission: PluginPermission,
): void {
  if (!hasGrantedPermission(entry.manifest, permission)) {
    throw new Error(`Plugin "${entry.manifest.id}" requires permission "${permission}"`)
  }
}

/** What a content-access decision reads of a table. */
export type ContentAccessTable = Pick<DataTable, 'slug' | 'createdByPluginId'>

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
  table: ContentAccessTable,
): ContentAccessEntry[] {
  return (manifest.contentAccess ?? []).filter((row) =>
    row.table === OWN_CREATED_TABLES_MARKER
      ? table.createdByPluginId === manifest.id
      : row.table === table.slug,
  )
}

/**
 * Whether the plugin may use every one of `modes` on `table`: each mode's
 * permission was granted AND a `contentAccess[]` entry covering the table
 * declares it. The ONE check of content table access: every
 * `api.cms.content.*` handler decides with it (on the resolved table, before
 * any repository read or write), and so does everything the hook bus hands a
 * plugin. Entries combine as a union: a mode is allowed when ANY matching
 * entry declares it.
 */
export function pluginHasContentTableAccess(
  entry: HostPluginRecord,
  table: ContentAccessTable,
  modes: readonly ContentAccessMode[],
): boolean {
  const matches = matchingContentAccessEntries(entry.manifest, table)
  return modes.every((mode) =>
    hasGrantedPermission(entry.manifest, CONTENT_ACCESS_MODE_PERMISSIONS[mode]) &&
    matches.some((row) => row.modes.includes(mode)),
  )
}

/**
 * Whether any table at all could pass `pluginHasContentTableAccess` for
 * `modes`: every mode is declared by some `contentAccess[]` entry. (The
 * permissions are the caller's to check.) False means the plugin can never
 * qualify, whatever table comes along.
 */
export function pluginDeclaresContentAccessModes(
  entry: HostPluginRecord,
  modes: readonly ContentAccessMode[],
): boolean {
  const declared = entry.manifest.contentAccess ?? []
  return modes.every((mode) => declared.some((row) => row.modes.includes(mode)))
}

/**
 * Refuse an id that is not this plugin's to register. It must sit in the
 * plugin's namespace (`<pluginId>.<name>`), and no other plugin may own it
 * more specifically: with `acme.vault` and `acme.vault.x` both present,
 * `acme.vault.x.files` belongs to the second, though it starts with both ids.
 *
 * "Present" means INSTALLED (the database), not merely loaded: a disabled
 * plugin keeps its namespace. Nested ids can no longer be installed side by
 * side (`nestedPluginId` at install); this check is what protects a site
 * that already has such a pair.
 */
export async function assertOwnsNamespacedId(
  db: DbClient,
  pluginId: string,
  id: string,
  what: string,
): Promise<void> {
  if (!isInPluginNamespace(id, pluginId)) {
    throw new Error(`${what} id "${id}" must start with the plugin id "${pluginId}.".`)
  }
  const owner = owningPluginId(id, [...(await listInstalledPluginIds(db)), ...hostPlugins.keys()])
  if (owner !== null && owner !== pluginId) {
    throw new Error(`${what} id "${id}" belongs to plugin "${owner}", not "${pluginId}".`)
  }
}

export interface PluginHostContext {
  db: DbClient
  /**
   * Root of the uploads tree, where the baked publish slot lives. Absent on a
   * server that runs without one; content handlers then skip the slot.
   */
  uploadsDir: string | undefined
}

let hostContext: PluginHostContext | null = null

export function setPluginHostContext(context: PluginHostContext): void {
  hostContext = context
}

export function getPluginHostContext(): PluginHostContext | null {
  return hostContext
}
