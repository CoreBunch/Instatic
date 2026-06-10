/**
 * Cross-cutting helpers used by every file in `server/handlers/cms/plugins/*`.
 *
 *  - `pluginsPayload` — the `{ plugins, adminPages }` shape every list/mutate
 *    endpoint returns to the admin UI. Centralised so the recent-crashes
 *    fan-out lives in one place.
 *  - Permission-grant helpers (`readPermissionGrants`,
 *    `assertPluginPermissionGrants`, `pluginManifestWithGrants`) — every
 *    route that loads a manifest needs to re-attach the user's granted
 *    permission set before passing it to the runtime.
 *  - `removePluginAssets` / `writePluginPackageFiles` / `readPluginPackageForm`
 *    — the on-disk side of zip install / uninstall.
 *  - `recordPluginAuditEvent` — the audit envelope shared by every mutation
 *    endpoint (install / update / enable / disable / delete).
 *  - `getEnabledPluginResource` — DB lookup used by the record CRUD routes.
 *  - `lifecycleErrorMessage` / `pluginNotFound` / `pluginRecordNotFound` /
 *    `pluginResourceNotFound` — small consistent shapes the route files
 *    pull from instead of inlining magic strings.
 *
 * Everything here is dependency-free relative to the other plugin files —
 * those import this one, not the other way round.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import { createAuditEvent } from '../../../repositories/audit'
import {
  findPluginResource,
  missingPluginPermissionGrants,
} from '@core/plugins/manifest'
import type {
  InstalledPlugin,
  PluginManifest,
  PluginPermission,
  PluginResource,
} from '@core/plugin-sdk'
import { maskSecretSettings } from '@core/plugin-sdk'
import {
  getInstalledPlugin,
  listInstalledPlugins,
  listPluginCrashes,
  type InstalledPluginResult,
} from '../../../repositories/plugins'
import { collectEnabledAdminPages } from '@core/plugins/manifest'
import { assertPathWithin } from '../../../util/pathWithin'
import { badRequest, jsonResponse } from '../../../http'
import { getErrorMessage } from '@core/utils/errorMessage'
import { requestAuditContext } from '../shared'

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type PluginAuditAction =
  | 'plugin.install'
  | 'plugin.update'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'plugin.delete'

/**
 * Record a plugin lifecycle action in the audit log. The mutation endpoints
 * (install / update / enable / disable / delete) emit the same envelope —
 * actor, action verb, and a metadata payload — so this helper exists purely
 * to keep the route handlers tidy. Update events carry the version delta in
 * metadata so audit log consumers can distinguish a fresh install from an
 * upgrade without re-fetching the plugin row.
 */
export async function recordPluginAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: PluginAuditAction,
  pluginId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'plugin',
    targetId: pluginId,
    metadata: { pluginId, ...metadata },
    ...requestAuditContext(req),
  })
}

// ---------------------------------------------------------------------------
// Response payloads
// ---------------------------------------------------------------------------

/**
 * Build a minimal `InstalledPlugin` stub for a plugin whose `manifest_json`
 * cannot be parsed. The stub carries `lifecycleStatus: 'error'` and the parse
 * error in `lastError` so the admin UI can display the problem and offer a
 * Remove button. `name` and `version` come from the row's own columns — they
 * are written at install time independently of `manifest_json` and are always
 * reliable.
 */
function brokenPluginStub(
  result: Extract<InstalledPluginResult, { kind: 'broken' }>,
): InstalledPlugin {
  const stubManifest: PluginManifest = {
    id: result.id,
    name: result.name,
    version: result.version,
    apiVersion: 1,
    permissions: [],
    resources: [],
    adminPages: [],
  }
  return {
    id: result.id,
    name: result.name,
    version: result.version,
    enabled: false,
    lifecycleStatus: 'error',
    lastError: result.reason,
    grantedPermissions: [],
    manifest: stubManifest,
    settings: {},
    installedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

/**
 * Mask a plugin's secret setting values before the row is serialized onto
 * any browser-bound response. Secret values must NEVER reach the admin UI
 * unmasked — server-side plugin code reads the real values through
 * `api.cms.settings.get`, which never goes through these handlers. Every
 * route that returns an `InstalledPlugin` (the list payload AND the
 * single-`plugin` envelopes on install / upgrade / enable / disable /
 * restart) MUST pass it through here.
 */
export function maskPluginSecrets(plugin: InstalledPlugin): InstalledPlugin {
  const declared = plugin.manifest.settings ?? []
  if (declared.length === 0) return plugin
  return { ...plugin, settings: maskSecretSettings(declared, plugin.settings) }
}

export async function pluginsPayload(db: DbClient) {
  const results = await listInstalledPlugins(db)
  // Materialise every result — ok or broken — as an InstalledPlugin for the
  // wire, masking secret setting values. Broken plugins get a stub with
  // lifecycleStatus='error' so the admin UI can surface the parse error and
  // offer a Remove button.
  const asPlugins = results.map((r) =>
    r.kind === 'ok' ? maskPluginSecrets(r.plugin) : brokenPluginStub(r),
  )
  // Attach recent crash events per plugin so the admin UI can render the
  // "Recent issues" panel without an extra round trip per card. Cap at 10
  // most recent — older events stay in the DB but the UI only shows the
  // recent slice.
  const pluginsWithCrashes = await Promise.all(
    asPlugins.map(async (plugin) => ({
      ...plugin,
      recentCrashes: await listPluginCrashes(db, plugin.id, 10),
    })),
  )
  // Only properly-parsed plugins contribute admin page nav entries — broken
  // plugins have stub manifests with empty adminPages arrays anyway, but
  // filtering explicitly makes the intent clear. Masked rows feed the page
  // routes too, because each route embeds a `pluginSettings` snapshot.
  const okPlugins = results
    .filter((r): r is Extract<InstalledPluginResult, { kind: 'ok' }> => r.kind === 'ok')
    .map((r) => maskPluginSecrets(r.plugin))
  return {
    plugins: pluginsWithCrashes,
    adminPages: collectEnabledAdminPages(okPlugins),
  }
}

export const pluginNotFound = (): Response =>
  jsonResponse({ error: 'Plugin not found' }, { status: 404 })

export const pluginRecordNotFound = (): Response =>
  jsonResponse({ error: 'Plugin record not found' }, { status: 404 })

export const pluginResourceNotFound = (): Response =>
  jsonResponse({ error: 'Plugin resource not found' }, { status: 404 })

export function lifecycleErrorMessage(err: unknown): string {
  return getErrorMessage(err, 'Plugin lifecycle hook failed')
}

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

export function readPermissionGrants(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is PluginPermission => typeof item === 'string') as PluginPermission[]
}

export function assertPluginPermissionGrants(
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[],
): Response | null {
  const missing = missingPluginPermissionGrants(manifest, grantedPermissions)
  if (missing.length === 0) return null
  return badRequest(`Plugin install requires permission grants: ${missing.join(', ')}`)
}

export function pluginManifestWithGrants(plugin: InstalledPlugin): PluginManifest {
  return {
    ...plugin.manifest,
    grantedPermissions: plugin.grantedPermissions,
  }
}

// ---------------------------------------------------------------------------
// Zip-package form parsing
// ---------------------------------------------------------------------------

export interface PluginPackageForm {
  file: File | null
  grantedPermissions: PluginPermission[]
}

export async function readPluginPackageForm(req: Request): Promise<PluginPackageForm> {
  const body = await req.formData()
  const file = body.get('file')
  const rawPermissions = body.get('grantedPermissions')
  let grantedPermissions: PluginPermission[] = []
  if (typeof rawPermissions === 'string') {
    try {
      // JSON.parse returns unknown — readPermissionGrants validates the shape
      // (must be array, items must be strings) before returning. Safe boundary.
      grantedPermissions = readPermissionGrants(JSON.parse(rawPermissions))
    } catch {
      grantedPermissions = []
    }
  }
  return {
    file: file instanceof File ? file : null,
    grantedPermissions,
  }
}

// ---------------------------------------------------------------------------
// On-disk asset management
// ---------------------------------------------------------------------------

export async function writePluginPackageFiles(
  uploadsDir: string,
  manifest: PluginManifest,
  files: Record<string, string | Uint8Array>,
): Promise<PluginManifest> {
  const relativeBasePath = `plugins/${manifest.id}/${manifest.version}`
  const diskBasePath = join(uploadsDir, relativeBasePath)
  await rm(diskBasePath, { recursive: true, force: true })

  for (const [path, content] of Object.entries(files)) {
    if (path === 'plugin.json') continue
    const outputPath = join(diskBasePath, path)
    await mkdir(dirname(outputPath), { recursive: true })
    // Binary entries (icon PNG/WEBP, fonts) come through as Uint8Array;
    // text entries (JS / JSON / SVG) as string. `writeFile` accepts both.
    if (typeof content === 'string') {
      await writeFile(outputPath, content, 'utf-8')
    } else {
      await writeFile(outputPath, content)
    }
  }

  return {
    ...manifest,
    assetBasePath: `/uploads/${relativeBasePath}`,
  }
}

export async function removePluginAssets(plugin: InstalledPlugin, uploadsDir?: string): Promise<void> {
  const assetBasePath = plugin.manifest.assetBasePath
  if (!uploadsDir || !assetBasePath?.startsWith('/uploads/plugins/')) return
  const relativeBasePath = assetBasePath.replace(/^\/uploads\/?/, '')
  const target = join(uploadsDir, relativeBasePath)
  // Defense-in-depth: a string-prefix match on `/uploads/plugins/` does not
  // block `..` traversal that the schema is supposed to reject — re-assert
  // containment after `path.join` normalises the segments so a corrupted
  // stored manifest (or a future schema regression) can't trigger an
  // arbitrary `rm -rf`.
  try {
    assertPathWithin(uploadsDir, target)
  } catch (err) {
    console.error('[plugins] removePluginAssets refused to delete escaping path:', err)
    return
  }
  await rm(target, { recursive: true, force: true })
}

/**
 * Delete a specific plugin version's on-disk dir. Used by the upgrade flow
 * (drop the old version after a successful upgrade, drop the new version
 * during rollback). `removePluginAssets` deletes the entire plugin tree;
 * this one is version-scoped.
 */
export async function removePluginVersionAssets(
  uploadsDir: string,
  pluginId: string,
  version: string,
): Promise<void> {
  await rm(join(uploadsDir, `plugins/${pluginId}/${version}`), {
    recursive: true,
    force: true,
  })
}

// ---------------------------------------------------------------------------
// Resource lookup
// ---------------------------------------------------------------------------

export async function getEnabledPluginResource(
  db: DbClient,
  pluginId: string,
  resourceId: string,
): Promise<PluginResource | null> {
  const result = await getInstalledPlugin(db, pluginId)
  if (!result || result.kind !== 'ok' || !result.plugin.enabled) return null
  return findPluginResource(result.plugin.manifest, resourceId)
}
