/**
 * Plugin install routes — JSON install, zip inspect, zip install, upgrade.
 *
 *   GET    /admin/api/cms/plugins                       — list installed plugins
 *   POST   /admin/api/cms/plugins                       — install from a JSON manifest
 *   POST   /admin/api/cms/plugins/inspect-package       — read a plugin .zip without installing
 *   POST   /admin/api/cms/plugins/package               — install (or upgrade) from a .zip
 *
 * The zip-install route is where most of the complexity lives. After
 * inspecting the manifest, it branches into one of three paths:
 *
 *   - Fresh install (`installFreshFromPackage`)
 *   - Upgrade (`installUpgradeFromPackage`) — runs old `deactivate`, swaps
 *     assets, runs new `migrate` + `activate`, drops old assets. Failure
 *     triggers `rollbackUpgrade`.
 *   - Downgrade — explicitly rejected.
 *
 * The lifecycle hooks (`install`, `activate`, `migrate`) are driven through
 * `runPluginLifecycleHook` and `runPluginMigrate` in `./lifecycle.ts` and
 * `../../../plugins/runtime`; the on-disk side lives in `./shared.ts`.
 */
import { gt as semverGt, lt as semverLt } from 'semver'
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import {
  getInstalledPlugin,
  installPlugin,
  setPluginLifecycleStatus,
} from '../../../repositories/plugins'
import { parsePluginManifest } from '@core/plugins/manifest'
import type {
  InstalledPlugin,
  PluginManifest,
  PluginPermission,
} from '@core/plugin-sdk'
import { readPluginPackage } from '../../../plugins/package'
import {
  loadPluginModulePack,
  loadPluginServerEntrypoint,
  primePluginSettingsCache,
  runPluginLifecycle,
  runPluginMigrate,
  unloadPlugin,
} from '../../../plugins/runtime'
import {
  activateSandboxedPluginModulePack,
  deactivatePluginModulePack,
} from '@core/plugins/modulePackLoader'
import { broadcastPluginEvent } from '../../../plugins/eventBroadcaster'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import { type CmsHandlerOptions } from '../shared'
import {
  assertPluginPermissionGrants,
  lifecycleErrorMessage,
  presentPluginSecrets,
  pluginManifestWithGrants,
  pluginsPayload,
  readPermissionGrants,
  readPluginPackageForm,
  recordPluginAuditEvent,
  removePluginVersionAssets,
  writePluginPackageFiles,
} from './shared'
import { runPluginLifecycleHook } from './lifecycle'
import { maybeAutoInstallPluginPack, type PluginPackSummary } from './pack'

// ---------------------------------------------------------------------------
// GET / POST /admin/api/cms/plugins  (list + JSON install)
// ---------------------------------------------------------------------------

export async function handlePluginsCollection(
  req: Request,
  db: DbClient,
  user: AuthUser,
): Promise<Response> {
  if (req.method === 'GET') {
    return jsonResponse(await pluginsPayload(db))
  }

  if (req.method === 'POST') {
    const PluginInstallBodySchema = Type.Object({
      manifest: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      grantedPermissions: Type.Optional(Type.Unknown()),
    })
    const body = await readValidatedBody(req, PluginInstallBodySchema)
    if (!body) return badRequest('Invalid plugin manifest')
    try {
      // JSON-installed plugins have no on-disk package — only the zip-install
      // path writes files and assigns `assetBasePath`. Drop any caller-supplied
      // value before validating so a malicious manifest cannot point the
      // filesystem sinks at attacker-chosen paths.
      const rawManifest: Record<string, unknown> = body.manifest ?? body
      const sanitizedInput = { ...rawManifest, assetBasePath: undefined }
      const manifest = parsePluginManifest(sanitizedInput)
      const grantedPermissions = readPermissionGrants(body.grantedPermissions)
      const grantError = assertPluginPermissionGrants(manifest, grantedPermissions)
      if (grantError) return grantError
      const installed = await installPlugin(db, manifest, grantedPermissions)
      const updatedResult = await setPluginLifecycleStatus(db, installed.id, 'active')
      const plugin = (updatedResult?.kind === 'ok' ? updatedResult.plugin : null) ?? installed
      await recordPluginAuditEvent(db, user, req, 'plugin.install', plugin.id)
      broadcastPluginEvent({
        kind: 'installed',
        pluginId: plugin.id,
        version: plugin.version,
        occurredAt: new Date().toISOString(),
      })
      return jsonResponse({ plugin: await presentPluginSecrets(db, plugin), ...(await pluginsPayload(db)) }, { status: 201 })
    } catch (err) {
      return badRequest(getErrorMessage(err, 'Invalid plugin manifest'))
    }
  }

  return methodNotAllowed()
}

// ---------------------------------------------------------------------------
// POST /admin/api/cms/plugins/inspect-package
// ---------------------------------------------------------------------------

export async function handleInspectPackage(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()

  const { file } = await readPluginPackageForm(req)
  if (!file) return badRequest('Missing plugin package')
  try {
    const pluginPackage = await readPluginPackage(file)
    return jsonResponse({ manifest: pluginPackage.manifest })
  } catch (err) {
    return badRequest(getErrorMessage(err, 'Invalid plugin package'))
  }
}

// ---------------------------------------------------------------------------
// POST /admin/api/cms/plugins/package  (zip install / upgrade)
// ---------------------------------------------------------------------------

export async function handlePackageInstall(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()
  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }

  const { file, grantedPermissions } = await readPluginPackageForm(req)
  if (!file) return badRequest('Missing plugin package')

  try {
    const pluginPackage = await readPluginPackage(file)
    const grantError = assertPluginPermissionGrants(pluginPackage.manifest, grantedPermissions)
    if (grantError) return grantError

    // Detect upgrade vs. fresh install BEFORE writing assets. The repository
    // does an upsert, but the lifecycle and rollback semantics differ
    // significantly between the two paths so we branch explicitly.
    // A broken existing install (corrupt manifest_json) is treated as if
    // there is no current install — the fresh-install path replaces it via
    // the upsert without attempting lifecycle hooks on the broken row.
    const existingResult = await getInstalledPlugin(db, pluginPackage.manifest.id)
    const existing = existingResult?.kind === 'ok' ? existingResult.plugin : null
    if (existing && semverLt(pluginPackage.manifest.version, existing.version)) {
      return badRequest(
        `Plugin "${existing.id}" is installed at ${existing.version}; refusing to downgrade to ${pluginPackage.manifest.version}.`,
      )
    }

    const ctx: InstallContext = {
      db,
      options,
      user,
      req,
      pluginPackage,
      grantedPermissions,
    }

    if (existing && semverGt(pluginPackage.manifest.version, existing.version)) {
      return await installUpgradeFromPackage({ ...ctx, existing })
    }
    return await installFreshFromPackage(ctx)
  } catch (err) {
    return badRequest(getErrorMessage(err, 'Invalid plugin package'))
  }
}

interface InstallContext {
  db: DbClient
  options: CmsHandlerOptions
  user: AuthUser
  req: Request
  pluginPackage: Awaited<ReturnType<typeof readPluginPackage>>
  grantedPermissions: PluginPermission[]
}

// ---------------------------------------------------------------------------
// Fresh install
// ---------------------------------------------------------------------------

async function installFreshFromPackage(ctx: InstallContext): Promise<Response> {
  const { db, options, user, req, pluginPackage, grantedPermissions } = ctx
  // `uploadsDir` was checked by the caller; assert to narrow the type.
  if (!options.uploadsDir) throw new Error('uploadsDir required')

  const manifest = await writePluginPackageFiles(
    options.uploadsDir,
    pluginPackage.manifest,
    pluginPackage.files,
  )
  const installed = await installPlugin(db, manifest, grantedPermissions)
  const installLifecycle = await runPluginLifecycleHook(db, installed, options, 'install', 'installed')
  if (!installLifecycle.ok) {
    return jsonResponse(
      { plugin: await presentPluginSecrets(db, installLifecycle.plugin), ...(await pluginsPayload(db)) },
      { status: 201 },
    )
  }

  // Reset worker + host state so partial registrations from `install` don't
  // leak into the activate cycle — `runPluginLifecycleHook` re-loads the
  // plugin entrypoint as part of its setup, which idempotently clears
  // prior host-side bookkeeping.
  await unloadPlugin(installed.id)
  const activateLifecycle = await runPluginLifecycleHook(
    db,
    installLifecycle.plugin,
    options,
    'activate',
    'active',
  )

  // Auto-install bundled pack — when the manifest declares one and the user
  // granted `visualComponents.register`, importing the pack is what they
  // expected. Skipping the manual "Install pack" click means a UI Kit-style
  // plugin "just works" after upload.
  const packSummary: PluginPackSummary | null = activateLifecycle.ok
    ? await maybeAutoInstallPluginPack(db, activateLifecycle.plugin, options, user, req)
    : null

  await recordPluginAuditEvent(db, user, req, 'plugin.install', activateLifecycle.plugin.id, {
    version: activateLifecycle.plugin.version,
  })
  broadcastPluginEvent({
    kind: 'installed',
    pluginId: activateLifecycle.plugin.id,
    version: activateLifecycle.plugin.version,
    occurredAt: new Date().toISOString(),
  })
  return jsonResponse(
    {
      plugin: await presentPluginSecrets(db, activateLifecycle.plugin),
      ...(await pluginsPayload(db)),
      pack: packSummary,
    },
    { status: 201 },
  )
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

interface UpgradeContext extends InstallContext {
  existing: InstalledPlugin
}

/**
 * Upgrade an existing plugin to a newer version.
 *
 * Order of operations:
 *   1. Run old version's `deactivate(api)` and unregister its module pack.
 *   2. Write the new version's assets to its own version-stamped dir
 *      (`/uploads/plugins/{id}/{newVersion}/`). The old version's dir is
 *      preserved on disk until step 6 — that's what makes rollback cheap.
 *   3. Replace the DB row with the new manifest (settings, granted
 *      permissions from the user's confirmation, installed_at preserved).
 *   4. Run new version's `migrate({ fromVersion }, api)`.
 *   5. Run new version's `activate(api)`.
 *   6. Delete the OLD version's asset dir.
 *
 * Any failure in steps 4 or 5 triggers a rollback: revert the DB row to
 * the previous manifest, delete the new version's assets, re-activate the
 * previous version. The plugin ends in `error` status with a message that
 * explains the upgrade failure.
 */
async function installUpgradeFromPackage(ctx: UpgradeContext): Promise<Response> {
  const { db, options, user, req, existing, pluginPackage, grantedPermissions } = ctx
  if (!options.uploadsDir) throw new Error('uploadsDir required')
  const fromVersion = existing.version
  const newVersion = pluginPackage.manifest.version
  const pluginId = existing.id

  // 1. Deactivate the old version. Best-effort — a deactivate failure
  //    shouldn't prevent the upgrade from proceeding (the new version is
  //    about to replace it anyway). We log and move on.
  await teardownPreviousVersion(db, pluginId, existing, options.uploadsDir)

  // 2. Write new assets.
  const newManifest = await writePluginPackageFiles(
    options.uploadsDir,
    pluginPackage.manifest,
    pluginPackage.files,
  )

  // 3. Replace DB row. `installPlugin` upserts — settings_json + installed_at
  //    are preserved by the SET clause (it doesn't reference them).
  const upgraded = await installPlugin(db, newManifest, grantedPermissions)
  // Refresh settings cache from the upserted row (merging decrypted secrets)
  // so the worker's `loadPluginServerEntrypoint` seeds the right values into
  // the worker's local mirror.
  await primePluginSettingsCache(db, upgraded)

  // 4 + 5. Try to migrate then activate. On any failure we restore the old
  //        version end-to-end.
  try {
    const upgradedManifest = pluginManifestWithGrants(upgraded)
    const loaded = await loadPluginServerEntrypoint(upgradedManifest, options.uploadsDir)
    if (loaded) {
      await runPluginMigrate(pluginId, fromVersion)
    }
    if (
      upgradedManifest.entrypoints?.modules
      && upgradedManifest.grantedPermissions?.includes('modules.register')
    ) {
      // Module pack failure is logged but doesn't abort activate — the
      // server-side hooks may still work without a registered module pack.
      try {
        const pack = await loadPluginModulePack(upgradedManifest, options.uploadsDir)
        if (pack) activateSandboxedPluginModulePack(upgradedManifest, pack)
      } catch (err) {
        console.error(`[plugin:${pluginId}] post-upgrade module pack load failed`, err)
      }
    }
    if (loaded) {
      await runPluginLifecycle(db, pluginId, 'activate')
    }
    await setPluginLifecycleStatus(db, pluginId, 'active')
  } catch (err) {
    const failureMessage = lifecycleErrorMessage(err)
    console.error(`[plugin:${pluginId}] upgrade ${fromVersion} → ${newVersion} failed:`, err)
    await rollbackUpgrade({ db, options, existing, newManifest })
    return jsonResponse(
      {
        error: `Upgrade failed: ${failureMessage}. Rolled back to version ${fromVersion}.`,
        ...(await pluginsPayload(db)),
      },
      { status: 400 },
    )
  }

  // 6. Drop the old version's assets. With worker isolation, plugin server
  //    files no longer live in the host process's `bun --watch` graph
  //    (they're imported inside the worker), so deleting them here doesn't
  //    race the response write — straightforward `await rm` is safe in
  //    both dev and production.
  await removePluginVersionAssets(options.uploadsDir, pluginId, fromVersion)

  // Re-fetch so the response carries the post-activation row (settings,
  // lifecycle = 'active', etc.).
  const finalResult = await getInstalledPlugin(db, pluginId)
  const finalRow = (finalResult?.kind === 'ok' ? finalResult.plugin : null) ?? upgraded

  // Auto-install pack on upgrade too — same trigger conditions as fresh
  // install. A new pack version often ships new VCs/templates that the
  // user expects to see immediately.
  const packSummary = await maybeAutoInstallPluginPack(db, finalRow, options, user, req)

  await recordPluginAuditEvent(db, user, req, 'plugin.update', pluginId, {
    fromVersion,
    toVersion: newVersion,
  })
  broadcastPluginEvent({
    kind: 'updated',
    pluginId,
    fromVersion,
    toVersion: newVersion,
    occurredAt: new Date().toISOString(),
  })
  return jsonResponse(
    {
      plugin: await presentPluginSecrets(db, finalRow),
      ...(await pluginsPayload(db)),
      pack: packSummary,
      upgrade: { fromVersion, toVersion: newVersion },
    },
    { status: 200 },
  )
}

/**
 * Tear down the currently-loaded version of a plugin before an upgrade or
 * rollback writes a different version's assets / DB row in its place.
 *
 *   1. Best-effort `deactivate` hook on the old manifest (idempotent
 *      re-load handles the "server restarted but plugin row exists" case).
 *   2. Drop the worker entry.
 *   3. Deactivate the canvas module pack.
 *
 * No exceptions propagate — a teardown failure shouldn't block the swap
 * (the new version is about to replace it anyway).
 */
async function teardownPreviousVersion(
  db: DbClient,
  pluginId: string,
  plugin: InstalledPlugin,
  uploadsDir: string,
): Promise<void> {
  try {
    const manifest = pluginManifestWithGrants(plugin)
    if (manifest.entrypoints?.server) {
      await loadPluginServerEntrypoint(manifest, uploadsDir)
      await runPluginLifecycle(db, pluginId, 'deactivate')
    }
  } catch (err) {
    console.error(`[plugin:${pluginId}] pre-upgrade deactivate failed`, err)
  }
  await unloadPlugin(pluginId)
  deactivatePluginModulePack(pluginId)
}

/**
 * Restore a plugin to its prior version after a failed upgrade.
 *
 *  - DB row is rolled back via `installPlugin(prevManifest, prevGrants)`.
 *    This is the same upsert path as a fresh install — `settings_json`
 *    and `installed_at` are preserved automatically.
 *  - The prior version's asset dir is still on disk (we didn't touch it
 *    during the upgrade attempt), so no asset restore is needed.
 *  - The new version's asset dir is removed.
 *  - Best-effort re-activation of the prior version. If THAT fails too,
 *    the plugin is parked in `error` state with a chained message; the
 *    site owner can resolve manually from the admin UI.
 */
async function rollbackUpgrade(args: {
  db: DbClient
  options: CmsHandlerOptions
  existing: InstalledPlugin
  newManifest: PluginManifest
}): Promise<void> {
  const { db, options, existing, newManifest } = args
  const pluginId = existing.id

  // Restore DB row to previous manifest + grants. The upsert preserves
  // settings + installed_at automatically.
  const restored = await installPlugin(
    db,
    pluginManifestWithGrants(existing),
    existing.grantedPermissions,
  )

  // Drop new version assets — the upgrade didn't take. With worker
  // isolation, plugin server files no longer live in the host's `bun
  // --watch` graph; plain `await rm` is safe.
  if (options.uploadsDir) {
    await removePluginVersionAssets(options.uploadsDir, pluginId, newManifest.version)
  }

  // Re-activate prior version. Best-effort: a rollback that crashes during
  // re-activation leaves the plugin disabled-with-error, which is still a
  // safer state than half-upgraded.
  await unloadPlugin(pluginId)
  deactivatePluginModulePack(pluginId)
  try {
    const restoredManifest = pluginManifestWithGrants(restored)
    await primePluginSettingsCache(db, restored)
    if (
      restoredManifest.entrypoints?.modules
      && restoredManifest.grantedPermissions?.includes('modules.register')
    ) {
      const pack = await loadPluginModulePack(restoredManifest, options.uploadsDir)
      if (pack) activateSandboxedPluginModulePack(restoredManifest, pack)
    }
    if (restoredManifest.entrypoints?.server) {
      const loaded = await loadPluginServerEntrypoint(restoredManifest, options.uploadsDir)
      if (loaded) await runPluginLifecycle(db, pluginId, 'activate')
    }
    await setPluginLifecycleStatus(
      db,
      pluginId,
      'error',
      `Upgrade to ${newManifest.version} failed; rolled back to ${existing.version}.`,
    )
  } catch (err) {
    console.error(`[plugin:${pluginId}] rollback re-activate failed`, err)
    await setPluginLifecycleStatus(
      db,
      pluginId,
      'error',
      `Upgrade to ${newManifest.version} failed and rollback re-activate failed: ${lifecycleErrorMessage(err)}`,
    )
  }
}
