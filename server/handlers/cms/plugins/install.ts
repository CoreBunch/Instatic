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
import { syncPluginMailTemplates } from '../../../mail/pluginTemplates'
import { forgetHeldMailOutcomes } from '../../../plugins/host/handlers/mail'
import { lt as semverLt } from 'semver'
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import {
  getInstalledPlugin,
  installPlugin,
  setPluginLifecycleStatus,
} from '../../../repositories/plugins'
import { assertNoNestedPluginId, NestedPluginIdError } from '../../../plugins/nestedPluginIds'
import { createSerialQueue } from '../../../util/serialQueue'
import { pluginRecordRekeyProblem, rekeyPluginRecords } from '../../../repositories/pluginRecords'
import { parsePluginManifest } from '@core/plugins/manifest'
import { withdrawnPluginAppScopeNames } from '@core/members'
import type {
  InstalledPlugin,
  PluginManifest,
  PluginResource,
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
import { withdrawPluginAppScopes } from '../../../members/apps/store'
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
      const nested = await refuseNestedPluginId(db, manifest.id)
      if (nested) return nested
      forgetHeldMailOutcomes(manifest.id)
      // A JSON install over an existing plugin is an upgrade of its manifest:
      // stored record keys must follow a changed `uniqueField` here too.
      const existingResult = await getInstalledPlugin(db, manifest.id)
      const previous = existingResult?.kind === 'ok' ? existingResult.plugin.manifest : null
      const { plugin: installed } = await storePluginManifest(db, previous, manifest, grantedPermissions, {
        restoring: false,
      })
      const updatedResult = await setPluginLifecycleStatus(db, installed.id, 'active')
      await syncPluginMailTemplates(db)
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

/**
 * The early answer, before a package's files are written. The check that
 * counts runs again where the row is written (`storePluginManifest`).
 */
async function refuseNestedPluginId(db: DbClient, pluginId: string): Promise<Response | null> {
  try {
    await assertNoNestedPluginId(db, pluginId)
    return null
  } catch (err) {
    if (err instanceof NestedPluginIdError) return badRequest(err.message)
    throw err
  }
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

    const nested = await refuseNestedPluginId(db, pluginPackage.manifest.id)
    if (nested) return nested

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

    // Anything still here is installed at the same version or lower, and the
    // lower case already returned. So `existing` means upgrade-or-reinstall,
    // and both belong on the upgrade path: it deactivates the running version
    // before replacing its files, runs `migrate`, and rolls back on failure.
    // The fresh path does none of that — it was written for a plugin that is
    // not there, and re-uploading the same version used to fall into it,
    // running `install` again on a live plugin with no rollback if it threw.
    try {
      if (existing) {
        return await installUpgradeFromPackage({ ...ctx, existing })
      }
      return await installFreshFromPackage(ctx)
    } finally {
      // Installed, upgraded or rolled back: the email templates in the
      // catalogue are the ones the installed manifest declares now.
      await syncPluginMailTemplates(db)
    }
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
  // A new install inherits nothing from an earlier one of the same id.
  forgetHeldMailOutcomes(pluginPackage.manifest.id)

  const manifest = await writePluginPackageFiles(
    options.uploadsDir,
    pluginPackage.manifest,
    pluginPackage.files,
  )
  const { plugin: installed } = await storePluginManifest(db, null, manifest, grantedPermissions, {
    restoring: false,
  })
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
 *      (`/uploads/plugins/{id}/{newVersion}/`). The old version's dir stays on
 *      disk — that's what makes rollback cheap, and published pages still
 *      link it by version (see step 6).
 *   3. Replace the DB row with the new manifest (settings, granted
 *      permissions from the user's confirmation, installed_at preserved).
 *      In the same transaction, withdraw the app scopes the new manifest
 *      dropped or reworded (`storePluginManifest`).
 *   4. Run new version's `migrate({ fromVersion }, api)`.
 *   5. Run new version's `activate(api)`.
 *   6. Leave the OLD version's asset dir alone. Baked pages reference plugin
 *      frontend assets by version, so the next publish retires it
 *      (`sweepStalePluginVersionAssets`), not the upgrade.
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

  // 0. A resource that gains or changes its `uniqueField` needs every stored
  //    record to take a distinct key. Check before touching anything, so an
  //    upgrade that cannot work is refused with the old version still running.
  for (const { resource, capped } of resourcesToRekey(existing.manifest, pluginPackage.manifest, false)) {
    if (resource.uniqueField === undefined) continue
    const problem = await pluginRecordRekeyProblem(
      db,
      { pluginId, resourceId: resource.id },
      resource.uniqueField,
      { capped },
    )
    if (problem) {
      return jsonResponse(
        { error: `This version cannot be installed: ${problem}`, ...(await pluginsPayload(db)) },
        { status: 400 },
      )
    }
  }

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

  // Any failure from here on restores the old version end-to-end.
  const failUpgrade = async (err: unknown): Promise<Response> => {
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

  // 3. Replace DB row. `installPlugin` upserts — settings_json + installed_at
  //    are preserved by the SET clause (it doesn't reference them). In the
  //    same transaction, before any new code runs, stored record keys follow
  //    the new declaration and the app scopes this version dropped or
  //    reworded are withdrawn. A record written since the check in step 0 can
  //    still collide; that fails here and takes the rollback path. A rollback
  //    does not bring withdrawn scopes back: the member is simply asked again.
  let upgraded: InstalledPlugin
  let withdrawnAppScopes: string[]
  try {
    ;({ plugin: upgraded, withdrawnAppScopes } = await storePluginManifest(
      db,
      existing.manifest,
      newManifest,
      grantedPermissions,
      { restoring: false },
    ))
  } catch (err) {
    return failUpgrade(err)
  }
  // Refresh settings cache from the upserted row (merging decrypted secrets)
  // so the worker's `loadPluginServerEntrypoint` seeds the right values into
  // the worker's local mirror.
  await primePluginSettingsCache(db, upgraded)

  // 4 + 5. Try to migrate then activate.
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
    return failUpgrade(err)
  }

  // 6. The old version's files STAY. Published pages link plugin frontend
  //    assets by version (`/uploads/plugins/<id>/<version>/frontend/…`), and
  //    those artefacts are only rewritten by a publish — so deleting here
  //    404'd every page already on disk. On a real site an upgrade took out
  //    jQuery, GSAP, Lenis, Splide and the boot script across every page at
  //    once, with no warning and no prompt to re-publish.
  //
  //    The next publish retires them, because that is the moment the URLs
  //    stop pointing at this version: `sweepStalePluginVersionAssets` in
  //    `server/publish/stalePluginAssets.ts`.

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
    ...(withdrawnAppScopes.length > 0 ? { withdrawnAppScopes } : {}),
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

  // Restore DB row to previous manifest + grants (the upsert preserves
  // settings + installed_at) and put the stored record keys back to what
  // that version declares, in one transaction. If even that fails, stop:
  // the row and keys are whatever the last successful transaction left
  // (consistent with each other), nothing is loaded, and the plugin says why.
  let restored: InstalledPlugin
  try {
    ;({ plugin: restored } = await storePluginManifest(
      db,
      newManifest,
      pluginManifestWithGrants(existing),
      existing.grantedPermissions,
      { restoring: true },
    ))
  } catch (err) {
    console.error(`[plugin:${pluginId}] rollback could not restore version ${existing.version}`, err)
    await unloadPlugin(pluginId)
    deactivatePluginModulePack(pluginId)
    await setPluginLifecycleStatus(
      db,
      pluginId,
      'error',
      `Upgrade to ${newManifest.version} failed and version ${existing.version} could not be restored: ${lifecycleErrorMessage(err)}`,
    )
    return
  }

  // Drop new version assets — the upgrade didn't take. With worker
  // isolation, plugin server files no longer live in the host's `bun
  // --watch` graph; plain `await rm` is safe.
  //
  // NOT when the versions match. A same-version reinstall writes into the
  // directory the restored manifest still points at, so deleting "the new
  // version" here would delete the only copy and leave every published page
  // linking a 404. Restoring the row is the whole rollback in that case.
  if (options.uploadsDir && newManifest.version !== existing.version) {
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

/**
 * Resources of `next` whose stored record keys must be rebuilt: the
 * `uniqueField` differs from what `previous` declared, or the resource is new
 * to the manifest (records may exist from a time it was not declared, with no
 * keys or stale ones).
 *
 * `capped` says whether the record limit applies. It guards one thing: a
 * plugin giving an existing resource a different unique field. It never
 * applies while restoring (a rollback puts back keys that were valid), nor to
 * a resource `previous` did not declare (also when there is no readable
 * previous manifest), so neither can be blocked by the size of a resource.
 */
function resourcesToRekey(
  previous: Pick<PluginManifest, 'resources'> | null,
  next: Pick<PluginManifest, 'resources'>,
  restoring: boolean,
): Array<{ resource: PluginResource; capped: boolean }> {
  const changed: Array<{ resource: PluginResource; capped: boolean }> = []
  for (const resource of next.resources) {
    const before = previous?.resources.find((candidate) => candidate.id === resource.id)
    if (before !== undefined && before.uniqueField === resource.uniqueField) continue
    changed.push({ resource, capped: before !== undefined && !restoring })
  }
  return changed
}

/**
 * Store a plugin's manifest and bring what depends on it into line, in one
 * transaction. Every path that writes a manifest goes through here (package
 * install, JSON install, upgrade, rollback).
 *
 * Record keys: the declaration of a `uniqueField` and the keys derived from
 * it change together or not at all.
 *
 * App scopes: a member allowed an app a scope in the words of its
 * description. Over `previous` (the manifest this one replaces) the scopes
 * that were dropped or reworded are withdrawn: the sign-ins that carried
 * them end and the apps lose them, so an old approval never opens whatever
 * this version puts behind the same name. Scopes that read the same keep
 * their approvals. With no `previous` nothing carries over at all, which
 * also covers an install over a row too broken to read.
 *
 * Returns the stored row and the scope names that were withdrawn.
 */
/** Runs plugin row writes one after another. */
const storeInTurn = createSerialQueue()

async function storePluginManifest(
  db: DbClient,
  previous: PluginManifest | null,
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[],
  options: { restoring: boolean },
): Promise<{ plugin: InstalledPlugin; withdrawnAppScopes: string[] }> {
  const withdrawnAppScopes = previous
    ? withdrawnPluginAppScopeNames(previous.appScopes ?? [], manifest.appScopes ?? [])
    : null
  // One store at a time in this process, with the nested-id check inside the
  // transaction that writes the row: two installs of a nested pair arriving
  // together cannot both find the table free of the other. (Several server
  // instances on one Postgres database are not serialised by this; the boot
  // warning and the ownership checks at registration cover a pair that
  // slipped through there.)
  const plugin = await storeInTurn(() => db.transaction(async (tx) => {
    await assertNoNestedPluginId(tx, manifest.id)
    const installed = await installPlugin(tx, manifest, grantedPermissions)
    for (const { resource, capped } of resourcesToRekey(previous, manifest, options.restoring)) {
      await rekeyPluginRecords(tx, { pluginId: manifest.id, resourceId: resource.id }, resource.uniqueField, {
        capped,
      })
    }
    if (withdrawnAppScopes === null) await withdrawPluginAppScopes(tx, manifest.id)
    else if (withdrawnAppScopes.length > 0) await withdrawPluginAppScopes(tx, manifest.id, withdrawnAppScopes)
    return installed
  }))
  return { plugin, withdrawnAppScopes: withdrawnAppScopes ?? [] }
}
