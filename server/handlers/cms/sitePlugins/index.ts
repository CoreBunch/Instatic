/**
 * Site plugin admin endpoints — the authoring/lifecycle surface for plugins
 * built from the site draft (docs/features/site-plugins.md). The
 * transport-independent service layer (list + activation engine) lives in
 * ./service.ts, shared with the AI plugin tools.
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
  sitePluginFolder,
  sitePluginIdFromLocalId,
  sitePluginTemplateFiles,
} from '@core/site-plugins'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import {
  requireAnyCapability,
  requireCapability,
  requireStepUp,
} from '../../../auth/authz'
import { getDraftSite, saveDraftSite } from '../../../repositories/site'
import { getInstalledPlugin } from '../../../repositories/plugins'
import { runPublishFlush } from '../../../publish/publishFlush'
import { listSitePluginRevisions } from '../../../plugins/sitePlugins/retention'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import { type CmsHandlerOptions } from '../shared'
import { activatePluginPackageFromDisk } from '../plugins/install'
import { presentPluginSecrets } from '../plugins/shared'
import { uninstallPluginById } from '../plugins/state'
import {
  buildDraftSitePlugin,
  listSitePlugins,
  republishAndSweep,
  runSitePluginActivation,
  sameStringSet,
  withSitePluginLock,
} from './service'

// Service re-exports — external consumers (the AI plugin tools) import the
// engine through this barrel.
export {
  buildDraftSitePlugin,
  listSitePlugins,
  runSitePluginActivation,
} from './service'
export type { SitePluginActivationResult } from './service'

const COLLECTION_PATH = '/admin/api/cms/site-plugins'
const ITEM_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)$/
const VALIDATE_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/validate$/
const PREVIEW_PACK_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/preview-pack\.js$/
const ACTIVATE_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/activate$/
const ROLLBACK_PATTERN = /^\/admin\/api\/cms\/site-plugins\/(?<localId>[^/]+)\/rollback$/

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
  const result = await buildDraftSitePlugin(db, localId)
  if (!result) {
    return jsonResponse({ error: `No site plugin source at plugins/${localId}/` }, { status: 404 })
  }
  return jsonResponse({ ok: result.ok, diagnostics: result.ok ? [] : result.diagnostics })
}

// ---------------------------------------------------------------------------
// GET /site-plugins/:localId/preview-pack.js — session-local canvas preview
// ---------------------------------------------------------------------------

async function handlePreviewPack(db: DbClient, localId: string): Promise<Response> {
  const result = await buildDraftSitePlugin(db, localId)
  if (!result) {
    return jsonResponse({ error: `No site plugin source at plugins/${localId}/` }, { status: 404 })
  }
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
  // First pass without grant-change authority: a `grants-changed` result IS
  // the consent moment — step up, then re-run with the change allowed. The
  // repeated pass only re-does the cheap draft read + manifest derivation
  // (the grant check fails before any build work).
  let result = await runSitePluginActivation({
    db, options, user, req, localId, allowGrantChange: false,
  })
  if (result.status === 'grants-changed') {
    const stepUp = await requireStepUp(req, db, user)
    if (stepUp) return stepUp
    result = await runSitePluginActivation({
      db, options, user, req, localId, allowGrantChange: true,
    })
  }

  switch (result.status) {
    case 'ok':
      return jsonResponse({
        plugin: await presentPluginSecrets(db, result.plugin),
        ...(result.upgrade ? { upgrade: result.upgrade } : {}),
        ...(result.skipped ? { skipped: true } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
        sitePlugins: await listSitePlugins(db, options.uploadsDir ?? null),
      })
    case 'not-found':
      return jsonResponse({ error: result.message }, { status: 404 })
    case 'disabled':
      return jsonResponse({ error: result.message }, { status: 409 })
    case 'invalid':
      return result.message === 'Uploads directory is not configured'
        ? jsonResponse({ error: result.message }, { status: 500 })
        : badRequest(result.message)
    case 'build-failed':
      return jsonResponse(
        { error: 'Site plugin build failed', diagnostics: result.diagnostics },
        { status: 400 },
      )
    case 'upgrade-error':
      return jsonResponse(
        { error: result.message, sitePlugins: await listSitePlugins(db, options.uploadsDir ?? null) },
        { status: 400 },
      )
    case 'grants-changed':
      // Unreachable — the step-up pass above re-runs with the change allowed.
      return badRequest('Activation requires grant-change consent')
  }
}

// ---------------------------------------------------------------------------
// POST /site-plugins/:localId/rollback — re-activate a retained revision
// ---------------------------------------------------------------------------

const RollbackBodySchema = Type.Object({
  /** A retained generated version (see the summary's `revisions`). */
  version: Type.String({ minLength: 1, maxLength: 80 }),
})

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
  const body = await readValidatedBody(req, RollbackBodySchema)
  if (!body) return badRequest('Pass the retained revision to roll back to as `version`')

  const pluginId = sitePluginIdFromLocalId(localId)
  const rowResult = await getInstalledPlugin(db, pluginId)
  const row = rowResult?.kind === 'ok' ? rowResult.plugin : null
  if (!row) {
    return jsonResponse({ error: `Site plugin "${localId}" has no runtime record` }, { status: 404 })
  }

  // Only a retained directory is a valid target — the version is user
  // input and must never be joined into a path unchecked.
  const retained = await listSitePluginRevisions(options.uploadsDir, pluginId)
  const target = retained.find((revision) => revision.version === body.version)
  if (!target) {
    return badRequest(`Revision ${body.version} of "${localId}" is not retained`)
  }
  if (target.version === row.version) {
    return badRequest(`Revision ${body.version} of "${localId}" is already active`)
  }

  let manifest: PluginManifest
  try {
    const manifestPath = join(
      options.uploadsDir,
      'plugins',
      pluginId,
      target.version,
      'plugin.json',
    )
    manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  } catch (err) {
    return badRequest(
      `Revision ${target.version} is unreadable: ${getErrorMessage(err, 'corrupt package')}`,
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
      { error: outcome.upgradeError, sitePlugins: await listSitePlugins(db, options.uploadsDir ?? null) },
      { status: 400 },
    )
  }

  const warning = await republishAndSweep(db, options.uploadsDir, manifest)

  return jsonResponse({
    plugin: await presentPluginSecrets(db, outcome.plugin),
    rolledBackTo: target.version,
    ...(warning ? { warning } : {}),
    sitePlugins: await listSitePlugins(db, options.uploadsDir ?? null),
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

  return jsonResponse({ ok: true, sitePlugins: await listSitePlugins(db, options.uploadsDir ?? null) })
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
      return jsonResponse({ sitePlugins: await listSitePlugins(db, options.uploadsDir ?? null) })
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
    const localId = rollbackMatch.groups['localId']!
    return withSitePluginLock(localId, () => handleRollback(req, db, options, user, localId))
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
    const localId = itemMatch.groups['localId']!
    return withSitePluginLock(localId, () => handleDelete(req, db, options, user, localId))
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}
