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
import { getInstalledPlugin, listInstalledPluginIds } from '../../../repositories/plugins'
import { owningPluginId } from '@core/plugins/namespaceOwnership'
import type { InstalledPlugin } from '@core/plugin-sdk'
import {
  applyPluginPackToSite,
  loadPluginPackFile,
  parsePluginPack,
  isPackIdInPluginNamespace,
  PluginPackError,
} from '../../../plugins/pack'
import { getDraftSite, saveDraftSite } from '../../../repositories/site'
import {
  findDataRowSlot,
  getDataRow,
  getDataRowBySlug,
  listDataRows,
  updateDataRowStatus,
  upsertDataRowDraft,
} from '../../../repositories/data'
import { keepPageStructuralCells, newPageStructuralCells } from '../../../writePolicy/pageStructuralCells'
import { pageFromRow, pageToCells } from '../../../../src/core/data/pageFromRow'
import { visualComponentToCells } from '../../../../src/core/data/componentFromRow'
import { savedLayoutFromRow, savedLayoutToCells } from '../../../../src/core/data/layoutFromRow'
import { vcSlugFromName } from '@core/visualComponents'
import { layoutSlugFromName } from '@core/layouts'
import { badRequest, jsonResponse, methodNotAllowed } from '../../../http'
import { type CmsHandlerOptions, requestAuditContext } from '../shared'
import { pluginNotFound } from './shared'
import { MAIN_SCOPE } from '../../../branches/scope'

export interface PluginPackSummary {
  installed: {
    visualComponents: { id: string; name: string }[]
    pages: { id: string; title: string }[]
    classes: { id: string; name: string }[]
    layouts: { id: string; name: string }[]
  }
  replaced: { visualComponents: string[]; pages: string[]; classes: string[]; layouts: string[] }
}

interface PackRow {
  id: string
  tableId: 'pages' | 'components' | 'layouts'
  cells: Record<string, unknown>
  slug: string
}

/**
 * Every id a pack writes under (pages, Visual Components, layouts, classes)
 * belongs to this plugin. The one check, for all four kinds:
 *   - an id with a `/` must have exactly the plugin id before its first `/`;
 *   - a dot-form id belongs to the installed plugin with the longest
 *     matching id, which must be this one (plugin ids may nest).
 */
function assertPackIdsOwned(pluginId: string, ids: readonly string[], installed: readonly string[]): void {
  for (const id of ids) {
    if (!isPackIdInPluginNamespace(pluginId, id)) {
      throw new PluginPackError(
        `Plugin "${pluginId}" pack entry "${id}" must be namespaced under the plugin id (e.g. "${pluginId}/${id}").`,
      )
    }
    if (id.includes('/')) continue
    const owner = owningPluginId(id, [...installed, pluginId])
    if (owner !== pluginId) {
      throw new PluginPackError(`Plugin "${pluginId}" pack entry "${id}" is in the namespace of plugin "${owner}".`)
    }
  }
}

/**
 * Everything else that can stop a pack row from being written, checked for
 * the WHOLE pack before anything is written: an id that belongs to a row of
 * another table, and a slug another row of the same table already holds (or
 * that two rows of the pack both want).
 */
async function assertPackRowsCanBeWritten(db: DbClient, pluginId: string, rows: readonly PackRow[]): Promise<void> {
  const wanted = new Map<string, string>()
  for (const row of rows) {
    const slot = await findDataRowSlot(db, MAIN_SCOPE, row.id)
    if (slot && slot.tableId !== row.tableId) {
      throw new PluginPackError(
        `Plugin "${pluginId}" pack entry "${row.id}" uses an id that already belongs to something else on this site.`,
      )
    }
    if (!row.slug) continue
    const key = `${row.tableId}\u0000${row.slug}`
    const holder = (await getDataRowBySlug(db, MAIN_SCOPE, row.tableId, row.slug))?.id ?? wanted.get(key)
    if (holder !== undefined && holder !== row.id) {
      throw new PluginPackError(
        `Plugin "${pluginId}" pack entry "${row.id}" cannot be installed: the slug "${row.slug}" is already used in "${row.tableId}".`,
      )
    }
    wanted.set(key, row.id)
  }
}

/**
 * Write one pack row under the id the pack names.
 *
 *  - The id is namespaced under the plugin id (`parsePluginPack` refuses
 *    anything else), so it cannot be a row the owner or another plugin made.
 *    What can still stop the write (the id held by a row of another table, a
 *    slug already taken) was checked for the whole pack beforehand
 *    (`assertPackRowsCanBeWritten`).
 *  - A page that is already there keeps its access rule and head settings.
 *  - A row the owner deleted still holds its id (inserting it again would
 *    fail), so it is brought back. It comes back as a draft: a re-sync is
 *    not a publish, and what was live before the delete stays off the site
 *    until someone publishes it.
 */
async function writePackRow(db: DbClient, row: PackRow, actorUserId: string): Promise<void> {
  const slot = await findDataRowSlot(db, MAIN_SCOPE, row.id)
  const stored = slot && !slot.deleted ? await getDataRow(db, MAIN_SCOPE, row.id) : null
  const cells = stored
    ? keepPageStructuralCells(stored, row.cells)
    : newPageStructuralCells(row.tableId, row.cells)
  await upsertDataRowDraft(db, MAIN_SCOPE, { ...row, cells }, actorUserId)
  if (slot?.deleted && slot.status !== 'draft') {
    await updateDataRowStatus(db, MAIN_SCOPE, row.id, 'draft', actorUserId)
  }
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

  const shell = await getDraftSite(db, MAIN_SCOPE)
  if (!shell) return null

  // Assemble a temporary SiteDocument for the pack merge function.
  // VCs and layouts are included so applyPluginPackToSite can detect
  // replaced ids.
  const [pageRows, vcRows, layoutRows] = await Promise.all([
    listDataRows(db, MAIN_SCOPE, 'pages'),
    listDataRows(db, MAIN_SCOPE, 'components'),
    listDataRows(db, MAIN_SCOPE, 'layouts'),
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

  // The pack's pages, Visual Components and layouts as data rows. Only the
  // pack's own: the site's other pages are not rewritten.
  const rows: PackRow[] = [
    ...pack.pages.map((page): PackRow => ({ id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug })),
    ...pack.visualComponents.map((vc): PackRow => ({
      id: vc.id, tableId: 'components', cells: visualComponentToCells(vc), slug: vcSlugFromName(vc.name),
    })),
    ...pack.layouts.map((layout): PackRow => ({
      id: layout.id, tableId: 'layouts', cells: savedLayoutToCells(layout), slug: layoutSlugFromName(layout.name),
    })),
  ]
  // Checked for the whole pack before the first write (the shell included).
  assertPackIdsOwned(plugin.id, [...rows.map((row) => row.id), ...pack.classes.map((cls) => cls.id)], await listInstalledPluginIds(db))
  await assertPackRowsCanBeWritten(db, plugin.id, rows)

  // Extract shell (strip pages, visualComponents, and layouts) and save
  const { pages: _pages, visualComponents: _vcs, layouts: _layouts, ...nextShell } = nextSiteDoc
  await saveDraftSite(db, MAIN_SCOPE, nextShell, actorUserId)
  for (const row of rows) await writePackRow(db, row, actorUserId)

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
