/**
 * Plugin pack installation.
 *
 * A plugin "pack" is the optional bundle of Visual Components, page
 * templates, class definitions, and saved layouts a plugin ships alongside
 * its server / module code. When a plugin manifest declares `pack` and the user has
 * granted `visualComponents.register`, importing the pack is what they
 * expected — both for fresh installs and upgrades. The route here is the
 * explicit re-sync trigger from the admin UI; the install flow imports
 * `installPluginPackToSite` directly to auto-install at install time.
 *
 *   POST /admin/api/cms/plugins/:id/pack/install
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import { createAuditEvent } from '../../../repositories/audit'
import { getInstalledPlugin } from '../../../repositories/plugins'
import type { InstalledPlugin } from '@core/plugin-sdk'
import {
  applyPluginPackToSite,
  loadPluginPackFile,
  parsePluginPack,
  PluginPackError,
} from '../../../plugins/pack'
import { getDraftSite, saveDraftSite } from '../../../repositories/site'
import {
  listDataRows,
  createDataRow,
  saveDataRowDraft,
} from '../../../repositories/data'
import { pageFromRow, pageToCells } from '../../../../src/core/data/pageFromRow'
import { visualComponentToCells, vcSlugFromName } from '../../../../src/core/data/componentFromRow'
import { savedLayoutFromRow, savedLayoutToCells, layoutSlugFromName } from '../../../../src/core/data/layoutFromRow'
import { badRequest, jsonResponse, methodNotAllowed } from '../../../http'
import { type CmsHandlerOptions, requestAuditContext } from '../shared'
import { pluginNotFound } from './shared'

export interface PluginPackSummary {
  installed: {
    visualComponents: { id: string; name: string }[]
    pages: { id: string; title: string }[]
    classes: { id: string; name: string }[]
    layouts: { id: string; name: string }[]
  }
  replaced: { visualComponents: string[]; pages: string[]; classes: string[]; layouts: string[] }
}

/**
 * Load the plugin's pack from disk, merge into the active site, and emit an
 * audit event. Returns `null` when the plugin doesn't declare a pack, has
 * no assets on disk, or there is no draft site yet. Used by both the
 * auto-install path (zip upload + upgrade) and the explicit
 * `POST /pack/install` route.
 */
async function installPluginPackToSite(
  db: DbClient,
  plugin: InstalledPlugin,
  uploadsDir: string,
  actorUserId: string,
  req: Request,
): Promise<PluginPackSummary | null> {
  if (!plugin.manifest.pack) return null
  if (!plugin.manifest.assetBasePath) return null
  const raw = await loadPluginPackFile(uploadsDir, plugin.manifest.assetBasePath, plugin.manifest.pack.path)
  const pack = parsePluginPack(plugin.id, raw)

  const shell = await getDraftSite(db)
  if (!shell) return null

  // Assemble a temporary SiteDocument for the pack merge function.
  // VCs and layouts are included so applyPluginPackToSite can detect
  // replaced ids.
  const [pageRows, vcRows, layoutRows] = await Promise.all([
    listDataRows(db, 'pages'),
    listDataRows(db, 'components'),
    listDataRows(db, 'layouts'),
  ])
  const { visualComponentFromRow } = await import('../../../../src/core/data/componentFromRow')
  const existingVCs = vcRows.flatMap((r) => {
    const vc = visualComponentFromRow(r)
    return vc ? [vc] : []
  })
  const existingLayouts = layoutRows.flatMap((r) => {
    const layout = savedLayoutFromRow(r)
    return layout ? [layout] : []
  })
  const tempSiteDoc = {
    ...shell,
    pages: pageRows.map(pageFromRow),
    visualComponents: existingVCs,
    layouts: existingLayouts,
  }

  const { site: nextSiteDoc, replaced } = applyPluginPackToSite(tempSiteDoc, pack)

  // Extract shell (strip pages, visualComponents, and layouts) and save
  const { pages: packPages, visualComponents: _vcs, layouts: _layouts, ...nextShell } = nextSiteDoc
  await saveDraftSite(db, nextShell, actorUserId)

  // Upsert pack pages as data_rows
  const existingPagesById = new Map(pageRows.map((r) => [r.id, r]))
  for (const page of packPages) {
    const cells = pageToCells(page)
    if (existingPagesById.has(page.id)) {
      await saveDataRowDraft(db, page.id, { cells, slug: page.slug }, actorUserId)
    } else {
      await createDataRow(db, { id: page.id, tableId: 'pages', cells, slug: page.slug }, actorUserId)
    }
  }

  // Upsert pack VCs as data_rows
  const existingVCsById = new Map(vcRows.map((r) => [r.id, r]))
  for (const vc of pack.visualComponents) {
    const cells = visualComponentToCells(vc)
    const slug = vcSlugFromName(vc.name)
    if (existingVCsById.has(vc.id)) {
      await saveDataRowDraft(db, vc.id, { cells, slug }, actorUserId)
    } else {
      await createDataRow(db, { id: vc.id, tableId: 'components', cells, slug }, actorUserId)
    }
  }

  // Upsert pack layouts as data_rows
  const existingLayoutRowsById = new Map(layoutRows.map((r) => [r.id, r]))
  for (const layout of pack.layouts) {
    const cells = savedLayoutToCells(layout)
    const slug = layoutSlugFromName(layout.name)
    if (existingLayoutRowsById.has(layout.id)) {
      await saveDataRowDraft(db, layout.id, { cells, slug }, actorUserId)
    } else {
      await createDataRow(db, { id: layout.id, tableId: 'layouts', cells, slug }, actorUserId)
    }
  }

  await createAuditEvent(db, {
    actorUserId,
    action: 'plugin.pack.install',
    targetType: 'plugin',
    targetId: plugin.id,
    metadata: {
      pluginId: plugin.id,
      installedVisualComponents: pack.visualComponents.length,
      installedPages: pack.pages.length,
      installedClasses: pack.classes.length,
      installedLayouts: pack.layouts.length,
      replacedVisualComponents: replaced.visualComponents,
      replacedPages: replaced.pages,
      replacedClasses: replaced.classes,
      replacedLayouts: replaced.layouts,
    },
    ...requestAuditContext(req),
  })
  return {
    installed: {
      visualComponents: pack.visualComponents.map((vc) => ({ id: vc.id, name: vc.name })),
      pages: pack.pages.map((p) => ({ id: p.id, title: p.title })),
      classes: pack.classes.map((c) => ({ id: c.id, name: c.name })),
      layouts: pack.layouts.map((l) => ({ id: l.id, name: l.name })),
    },
    replaced,
  }
}

/**
 * Best-effort wrapper around `installPluginPackToSite` for the install /
 * upgrade flows. Swallows errors so a pack failure doesn't abort the
 * surrounding install — the caller already has a working plugin row, the
 * pack just isn't synced.
 */
export async function maybeAutoInstallPluginPack(
  db: DbClient,
  plugin: InstalledPlugin,
  options: CmsHandlerOptions,
  user: AuthUser,
  req: Request,
): Promise<PluginPackSummary | null> {
  if (!options.uploadsDir) return null
  if (!plugin.manifest.pack) return null
  if (!plugin.grantedPermissions.includes('visualComponents.register')) return null

  try {
    return await installPluginPackToSite(db, plugin, options.uploadsDir, user.id, req)
  } catch (err) {
    console.error(`[plugins:${plugin.id}] auto pack install failed`, err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Route handler — POST /admin/api/cms/plugins/:id/pack/install
// ---------------------------------------------------------------------------

export async function handlePluginPackInstall(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions,
  user: AuthUser,
  pluginId: string,
): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed()
  if (!options.uploadsDir) {
    return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
  }

  const result = await getInstalledPlugin(db, pluginId)
  if (!result) return pluginNotFound()
  if (result.kind === 'broken') {
    return badRequest(`Plugin "${pluginId}" has a corrupt manifest — remove and reinstall it`)
  }
  const plugin = result.plugin
  // A disabled plugin pushing pack content (Visual Components, pages,
  // classes) into the user's draft site contradicts the user's intent in
  // disabling the plugin. Reject the action explicitly so the API matches
  // the UI gate (see PluginsPage `Re-sync pack` button).
  if (!plugin.enabled) {
    return badRequest(`Plugin "${pluginId}" is disabled — enable it before re-syncing its pack`)
  }
  if (!plugin.grantedPermissions.includes('visualComponents.register')) {
    return badRequest(`Plugin "${pluginId}" requires the visualComponents.register permission to install a pack`)
  }
  if (!plugin.manifest.pack) {
    return badRequest(`Plugin "${pluginId}" does not declare a pack`)
  }
  if (!plugin.manifest.assetBasePath) {
    return badRequest(`Plugin "${pluginId}" has no on-disk package`)
  }

  try {
    const summary = await installPluginPackToSite(db, plugin, options.uploadsDir, user.id, req)
    if (!summary) {
      return badRequest('No draft site to install pack into; finish initial setup first.')
    }
    return jsonResponse(summary)
  } catch (err) {
    if (err instanceof PluginPackError) return badRequest(err.message)
    throw err
  }
}
