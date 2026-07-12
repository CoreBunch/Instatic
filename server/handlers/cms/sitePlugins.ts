/**
 * Site plugin admin endpoints — the authoring/lifecycle surface for plugins
 * built from the site draft (docs/features/site-plugins.md).
 *
 *   GET    /admin/api/cms/site-plugins                        — union of draft plugins/* folders and
 *                                                               site-local runtime rows, with computed states
 *   POST   /admin/api/cms/site-plugins                        — scaffold a new site plugin into the draft
 *   POST   /admin/api/cms/site-plugins/:localId/validate      — validate-only build → diagnostics
 *   GET    /admin/api/cms/site-plugins/:localId/preview-pack.js — draft module pack bundle (session-local canvas preview)
 *   POST   /admin/api/cms/site-plugins/:localId/activate      — build + install/upgrade lifecycle (+ publish coupling)
 *   POST   /admin/api/cms/site-plugins/:localId/rollback      — re-activate the retained previous revision
 *   DELETE /admin/api/cms/site-plugins/:localId[?force=true]  — uninstall runtime row + delete draft source
 *
 * Authority model (design → "Activation Semantics"):
 *   - authoring (scaffold) needs `plugins.edit`, never plugins.install —
 *     the same capability the collab guard requires for plugin-file writes;
 *   - validation/preview need no elevated capability (site.read);
 *   - activation needs `plugins.install`, with step-up ONLY on the consent
 *     moments — first activation and grant-set changes. Same-grant rebuilds
 *     skip both the review and the step-up.
 *
 * Deactivate/restart/settings/logs ride the EXISTING plugin routes by id
 * (`site.<localId>` is an ordinary installed_plugins row) — no duplicates.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { SiteFile } from '@core/files/schemas'
import type { PluginManifest } from '@core/plugin-sdk'
import { parsePluginManifest } from '@core/plugins/manifest'
import {
  SITE_PLUGIN_LOCAL_ID_PATTERN,
  SITE_PLUGIN_TEMPLATE_IDS,
  computeSitePluginContentHash,
  computeSitePluginState,
  contentHashOfVersion,
  deriveSitePluginManifest,
  discoverSitePlugins,
  sitePluginFolder,
  sitePluginIdFromLocalId,
  sitePluginTemplateFiles,
  type SitePluginSummary,
} from '@core/site-plugins'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { DbClient } from '../../db/client'
import type { AuthUser } from '../../repositories/users'
import {
  requireAnyCapability,
  requireCapability,
  requireStepUp,
} from '../../auth/authz'
import { getDraftSite, saveDraftSite } from '../../repositories/site'
import { getInstalledPlugin, listInstalledPlugins } from '../../repositories/plugins'
import { runPublishFlush } from '../../publish/publishFlush'
import { republishAllPages } from '../../publish/republish'
import { bumpPublishVersionSerialized } from '../../publish/publishState'
import { buildSitePlugin } from '../../plugins/sitePlugins/build'
import {
  previousSitePluginRevision,
  sweepSitePluginRevisions,
} from '../../plugins/sitePlugins/retention'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { type CmsHandlerOptions } from './shared'
import { activatePluginPackageFromDisk } from './plugins/install'
import { presentPluginSecrets } from './plugins/shared'
import { uninstallPluginById } from './plugins/state'

const COLLECTION_PATH = '/admin/api/cms/site-plugins'
const ITEM_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)$/
const VALIDATE_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/validate$/
const PREVIEW_PACK_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/preview-pack\.js$/
const ACTIVATE_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/activate$/
const ROLLBACK_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/rollback$/

// ---------------------------------------------------------------------------
// Draft access
// ---------------------------------------------------------------------------

/**
 * Read the persisted draft's plugin files — flushing the collab relay first
 * so edits still inside the persist debounce window are included ("flush
 * the editor's pending save, then read the persisted draft").
 */
async function readDraftPluginFiles(db: DbClient): Promise<SiteFile[]> {
  await runPublishFlush()
  const shell = await getDraftSite(db)
  return shell?.files.filter((file) => file.type === 'plugin') ?? []
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

// ---------------------------------------------------------------------------
// GET /site-plugins — the list
// ---------------------------------------------------------------------------

async function listSitePlugins(db: DbClient): Promise<SitePluginSummary[]> {
  const draftFiles = await readDraftPluginFiles(db)
  let discovered: ReturnType<typeof discoverSitePlugins>
  try {
    discovered = discoverSitePlugins(draftFiles)
  } catch (err) {
    // An invalid local id in the draft must not blank the whole list — the
    // offending folder simply can't be discovered until renamed.
    console.error('[site-plugins] draft discovery failed:', err)
    discovered = []
  }
  const draftByLocalId = new Map(discovered.map((plugin) => [plugin.localId, plugin]))

  const rows = (await listInstalledPlugins(db))
    .flatMap((result) => (result.kind === 'ok' ? [result.plugin] : []))
    .filter((plugin) => plugin.source === 'site-local')
  const rowByLocalId = new Map(
    rows.map((plugin) => [plugin.id.replace(/^site\./, ''), plugin]),
  )

  // Union — a deleted folder must never hide a still-running backend.
  const localIds = [...new Set([...draftByLocalId.keys(), ...rowByLocalId.keys()])].sort()

  return localIds.map((localId) => {
    const draft = draftByLocalId.get(localId) ?? null
    const row = rowByLocalId.get(localId) ?? null

    let manifest: PluginManifest | null = null
    let manifestError: string | null = null
    let draftContentHash: string | null = null
    if (draft) {
      draftContentHash = computeSitePluginContentHash(draft.files)
      if (draft.manifestFile?.content) {
        try {
          manifest = deriveSitePluginManifest({
            localId,
            draftManifestJson: draft.manifestFile.content,
            files: draft.files,
            previousVersion: row?.version ?? null,
            contentHash: draftContentHash,
          })
        } catch (err) {
          manifestError = getErrorMessage(err, 'Invalid site plugin manifest')
        }
      } else {
        manifestError = `plugins/${localId}/plugin.json is missing`
      }
    }

    const declared = manifest?.permissions ?? []
    const granted = row?.grantedPermissions ?? []
    const grantsChanged = manifest !== null && row !== null && !sameStringSet(declared, granted)

    const state = computeSitePluginState({
      hasDraftSource: draft !== null,
      row: row
        ? { version: row.version, lifecycleStatus: row.lifecycleStatus, enabled: row.enabled }
        : null,
      manifestError,
      draftContentHash,
      activeContentHash: contentHashOfVersion(row?.version),
      grantsChanged,
    })

    return {
      localId,
      pluginId: sitePluginIdFromLocalId(localId),
      name: manifest?.name ?? row?.name ?? localId,
      state,
      activeVersion: row?.version ?? null,
      hasDraftSource: draft !== null,
      hasModules: Boolean(manifest?.entrypoints?.modules),
      declaredPermissions: declared,
      grantedPermissions: granted,
      newPermissions: declared.filter((permission) => !granted.includes(permission)),
      removedPermissions: granted.filter((permission) => !declared.includes(permission)),
      manifestError,
      lastError: row?.lastError ?? null,
    }
  })
}

// ---------------------------------------------------------------------------
// POST /site-plugins — scaffold
// ---------------------------------------------------------------------------

const ScaffoldBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  localId: Type.String({ pattern: SITE_PLUGIN_LOCAL_ID_PATTERN.source, maxLength: 64 }),
  template: Type.Union(SITE_PLUGIN_TEMPLATE_IDS.map((id) => Type.Literal(id))),
})

async function handleScaffold(req: Request, db: DbClient): Promise<Response> {
  const body = await readValidatedBody(req, ScaffoldBodySchema)
  if (!body) {
    return badRequest(
      'Invalid site plugin scaffold — name, kebab-case localId, and a valid template are required',
    )
  }

  await runPublishFlush()
  const shell = await getDraftSite(db)
  if (!shell) return badRequest('No draft site exists yet')

  const folder = sitePluginFolder(body.localId)
  if (shell.files.some((file) => file.path.startsWith(folder))) {
    return jsonResponse(
      { error: `A site plugin folder "${folder}" already exists` },
      { status: 409 },
    )
  }
  const existingRow = await getInstalledPlugin(db, sitePluginIdFromLocalId(body.localId))
  if (existingRow) {
    return jsonResponse(
      { error: `A site plugin "${body.localId}" already has a runtime record — pick another id` },
      { status: 409 },
    )
  }

  const now = Date.now()
  const created: SiteFile[] = sitePluginTemplateFiles(body.template, body.localId, body.name).map(
    (file) => ({
      id: nanoid(),
      path: file.path,
      type: 'plugin',
      content: file.content,
      createdAt: now,
      updatedAt: now,
    }),
  )

  // Out-of-relay shell write — saveDraftSite fires notifyShellWrite, the
  // relay resets the site doc, and connected editors rebind with the new
  // files. The scaffold is a rare, explicit action; the reset is the
  // designed path for external writers.
  await saveDraftSite(db, {
    ...shell,
    files: [...shell.files, ...created],
    updatedAt: now,
  })

  return jsonResponse(
    { ok: true, localId: body.localId, files: created.map((file) => file.path) },
    { status: 201 },
  )
}

// ---------------------------------------------------------------------------
// POST /site-plugins/:localId/validate — diagnostics without activation
// ---------------------------------------------------------------------------

async function handleValidate(db: DbClient, localId: string): Promise<Response> {
  const draftFiles = await readDraftPluginFiles(db)
  const plugin = discoverSitePlugins(draftFiles).find((entry) => entry.localId === localId)
  if (!plugin) {
    return jsonResponse({ error: `No site plugin source at plugins/${localId}/` }, { status: 404 })
  }
  const rowResult = await getInstalledPlugin(db, sitePluginIdFromLocalId(localId))
  const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
  const result = await buildSitePlugin({
    localId,
    files: plugin.files,
    previousVersion: row?.version ?? null,
    validateOnly: true,
  })
  if (!result.ok) {
    return jsonResponse({ ok: false, diagnostics: result.diagnostics })
  }
  return jsonResponse({ ok: true, diagnostics: [] })
}

// ---------------------------------------------------------------------------
// GET /site-plugins/:localId/preview-pack.js — session-local canvas preview
// ---------------------------------------------------------------------------

async function handlePreviewPack(db: DbClient, localId: string): Promise<Response> {
  const draftFiles = await readDraftPluginFiles(db)
  const plugin = discoverSitePlugins(draftFiles).find((entry) => entry.localId === localId)
  if (!plugin) {
    return jsonResponse({ error: `No site plugin source at plugins/${localId}/` }, { status: 404 })
  }
  const rowResult = await getInstalledPlugin(db, sitePluginIdFromLocalId(localId))
  const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
  const result = await buildSitePlugin({
    localId,
    files: plugin.files,
    previousVersion: row?.version ?? null,
    validateOnly: true,
  })
  if (!result.ok) {
    return jsonResponse(
      { error: `Draft build failed: ${result.diagnostics.join('; ')}` },
      { status: 404 },
    )
  }
  if (result.modulesBundle === undefined) {
    return jsonResponse(
      { error: `Site plugin "${localId}" declares no module pack` },
      { status: 404 },
    )
  }
  // Draft bundles must never cache — every preview reflects the current draft.
  return new Response(result.modulesBundle, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

// ---------------------------------------------------------------------------
// POST /site-plugins/:localId/activate — Build & activate
// ---------------------------------------------------------------------------

async function handleActivate(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  localId: string,
): Promise<Response> {
  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }
  const draftFiles = await readDraftPluginFiles(db)
  const plugin = discoverSitePlugins(draftFiles).find((entry) => entry.localId === localId)
  if (!plugin) {
    return jsonResponse({ error: `No site plugin source at plugins/${localId}/` }, { status: 404 })
  }
  if (!plugin.manifestFile?.content) {
    return badRequest(`plugins/${localId}/plugin.json is missing`)
  }

  const rowResult = await getInstalledPlugin(db, sitePluginIdFromLocalId(localId))
  const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
  const contentHash = computeSitePluginContentHash(plugin.files)

  // Skip when the active revision already matches the draft source.
  if (
    row &&
    row.lifecycleStatus === 'active' &&
    contentHashOfVersion(row.version) === contentHash
  ) {
    return jsonResponse({
      plugin: await presentPluginSecrets(db, row),
      skipped: true,
      sitePlugins: await listSitePlugins(db),
    })
  }

  // Derive BEFORE building: the grant diff decides whether this request is
  // a consent moment (step-up) — and a manifest error should fail before
  // any bundling work.
  let manifest: PluginManifest
  try {
    manifest = deriveSitePluginManifest({
      localId,
      draftManifestJson: plugin.manifestFile.content,
      files: plugin.files,
      previousVersion: row?.version ?? null,
      contentHash,
    })
  } catch (err) {
    return badRequest(getErrorMessage(err, 'Invalid site plugin manifest'))
  }

  // Step-up on the consent moments only: first activation, or a changed
  // grant set. Same-grant rebuilds skip it — the security boundary is the
  // grant set, not the code revision.
  const grantsChanged = !row || !sameStringSet(row.grantedPermissions, manifest.permissions)
  if (grantsChanged) {
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }

  const built = await buildSitePlugin({
    localId,
    files: plugin.files,
    previousVersion: row?.version ?? null,
    uploadsDir: options.uploadsDir,
    validateOnly: false,
  })
  if (!built.ok) {
    return jsonResponse(
      { error: `Site plugin build failed`, diagnostics: built.diagnostics },
      { status: 400 },
    )
  }

  // Grants = declared, in both directions: activation grants exactly what
  // the draft declares, and dropping a permission shrinks the grant.
  const outcome = await activatePluginPackageFromDisk({
    db,
    options,
    user,
    req,
    manifest: built.manifest,
    grantedPermissions: built.manifest.permissions,
    source: 'site-local',
  })
  if (outcome.upgradeError) {
    return jsonResponse(
      { error: outcome.upgradeError, sitePlugins: await listSitePlugins(db) },
      { status: 400 },
    )
  }

  await republishAndSweep(db, options.uploadsDir, built.manifest)

  return jsonResponse({
    plugin: await presentPluginSecrets(db, outcome.plugin),
    ...(outcome.upgrade ? { upgrade: outcome.upgrade } : {}),
    sitePlugins: await listSitePlugins(db),
  })
}

/**
 * Publish coupling (design → "Revision/publish coupling — defined"): baked
 * Layer-A HTML embeds versioned asset URLs, so when the plugin has
 * visitor-facing surfaces the host republishes BEFORE any old revision is
 * garbage-collected — published pages must never reference a deleted
 * revision. Backend-only plugins skip the republish and sweep immediately.
 */
async function republishAndSweep(
  db: DbClient,
  uploadsDir: string,
  manifest: PluginManifest,
): Promise<void> {
  const visitorFacing =
    (manifest.frontend?.assets.length ?? 0) > 0 || Boolean(manifest.entrypoints?.modules)
  if (visitorFacing) {
    try {
      await republishAllPages(db, uploadsDir)
      await bumpPublishVersionSerialized()
    } catch (err) {
      // A failed republish must not fail the activation — but it must also
      // not trigger the sweep (old revision stays referenced).
      console.error(`[site-plugins] post-activation republish failed for ${manifest.id}:`, err)
      return
    }
  }
  await sweepSitePluginRevisions(uploadsDir, manifest.id, manifest.version)
}

// ---------------------------------------------------------------------------
// POST /site-plugins/:localId/rollback — re-activate the previous revision
// ---------------------------------------------------------------------------

async function handleRollback(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  localId: string,
): Promise<Response> {
  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }
  const pluginId = sitePluginIdFromLocalId(localId)
  const rowResult = await getInstalledPlugin(db, pluginId)
  const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
  if (!row) {
    return jsonResponse({ error: `Site plugin "${localId}" has no runtime record` }, { status: 404 })
  }

  const previousVersion = await previousSitePluginRevision(options.uploadsDir, pluginId, row.version)
  if (!previousVersion) {
    return badRequest(`No previous revision of "${localId}" is retained to roll back to`)
  }

  let manifest: PluginManifest
  try {
    const manifestPath = join(
      options.uploadsDir,
      'plugins',
      pluginId,
      previousVersion,
      'plugin.json',
    )
    manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  } catch (err) {
    return badRequest(
      `Previous revision ${previousVersion} is unreadable: ${getErrorMessage(err, 'corrupt package')}`,
    )
  }

  // Rolling back to a revision with a DIFFERENT grant set is a consent
  // moment too (it may re-grant something the current draft dropped).
  if (!sameStringSet(row.grantedPermissions, manifest.permissions)) {
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
  }

  const outcome = await activatePluginPackageFromDisk({
    db,
    options,
    user,
    req,
    manifest,
    grantedPermissions: manifest.permissions,
    source: 'site-local',
  })
  if (outcome.upgradeError) {
    return jsonResponse(
      { error: outcome.upgradeError, sitePlugins: await listSitePlugins(db) },
      { status: 400 },
    )
  }

  await republishAndSweep(db, options.uploadsDir, manifest)

  return jsonResponse({
    plugin: await presentPluginSecrets(db, outcome.plugin),
    rolledBackTo: previousVersion,
    sitePlugins: await listSitePlugins(db),
  })
}

// ---------------------------------------------------------------------------
// DELETE /site-plugins/:localId — uninstall + delete draft source
// ---------------------------------------------------------------------------

async function handleDelete(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  localId: string,
): Promise<Response> {
  const pluginId = sitePluginIdFromLocalId(localId)
  const force = new URL(req.url).searchParams.get('force') === 'true'

  // Runtime teardown first (hooks unless forced) — a hook failure aborts
  // with the same "fix or force" contract as installed plugins, leaving the
  // draft source untouched. `Response.ok` = HTTP 2xx here.
  const rowResult = await getInstalledPlugin(db, pluginId)
  if (rowResult) {
    const teardown = await uninstallPluginById(req, db, options, user, pluginId, force)
    if (!teardown.ok) return teardown
  }

  // Then the draft source folder.
  await runPublishFlush()
  const shell = await getDraftSite(db)
  if (shell) {
    const folder = sitePluginFolder(localId)
    const remaining = shell.files.filter((file) => !file.path.startsWith(folder))
    if (remaining.length !== shell.files.length) {
      await saveDraftSite(db, { ...shell, files: remaining, updatedAt: Date.now() })
    }
  }

  return jsonResponse({ ok: true, sitePlugins: await listSitePlugins(db) })
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleSitePluginsRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
): Promise<Response | null> {
  const { pathname } = new URL(req.url)
  if (pathname !== COLLECTION_PATH && !pathname.startsWith(`${COLLECTION_PATH}/`)) return null

  if (pathname === COLLECTION_PATH) {
    if (req.method === 'GET') {
      // The Plugins page reads with plugins.read; the IDE's status chip works
      // for pure site developers via site.read.
      const user = await requireAnyCapability(req, db, ['plugins.read', 'site.read'])
      if (user instanceof Response) return user
      return jsonResponse({ sitePlugins: await listSitePlugins(db) })
    }
    if (req.method === 'POST') {
      // Scaffolding writes plugin source into the draft — the authoring
      // capability, NOT a plugin power grant (activation is where powers
      // happen). Same gate as the collab guard on plugin-file writes.
      const user = await requireCapability(req, db, 'plugins.edit')
      if (user instanceof Response) return user
      return handleScaffold(req, db)
    }
    return methodNotAllowed()
  }

  const validateMatch = VALIDATE_PATTERN.exec(pathname)
  if (validateMatch?.groups) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireAnyCapability(req, db, ['plugins.read', 'site.read'])
    if (user instanceof Response) return user
    return handleValidate(db, validateMatch.groups['localId']!)
  }

  const previewMatch = PREVIEW_PACK_PATTERN.exec(pathname)
  if (previewMatch?.groups) {
    if (req.method !== 'GET') return methodNotAllowed()
    const user = await requireAnyCapability(req, db, ['plugins.read', 'site.read'])
    if (user instanceof Response) return user
    return handlePreviewPack(db, previewMatch.groups['localId']!)
  }

  const activateMatch = ACTIVATE_PATTERN.exec(pathname)
  if (activateMatch?.groups) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireCapability(req, db, 'plugins.install')
    if (user instanceof Response) return user
    return handleActivate(req, db, options, user, activateMatch.groups['localId']!)
  }

  const rollbackMatch = ROLLBACK_PATTERN.exec(pathname)
  if (rollbackMatch?.groups) {
    if (req.method !== 'POST') return methodNotAllowed()
    const user = await requireCapability(req, db, 'plugins.install')
    if (user instanceof Response) return user
    return handleRollback(req, db, options, user, rollbackMatch.groups['localId']!)
  }

  const itemMatch = ITEM_PATTERN.exec(pathname)
  if (itemMatch?.groups) {
    if (req.method !== 'DELETE') return methodNotAllowed()
    // Deleting a site plugin is the install operation's inverse — same
    // capability + step-up as uninstalling an installed plugin.
    const user = await requireCapability(req, db, 'plugins.install')
    if (user instanceof Response) return user
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    return handleDelete(req, db, options, user, itemMatch.groups['localId']!)
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}
