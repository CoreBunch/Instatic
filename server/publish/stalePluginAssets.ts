/**
 * Retire a plugin version's files only once nothing published points at them.
 *
 * Published HTML links a plugin's frontend assets by version —
 * `/uploads/plugins/<id>/<version>/frontend/app.js` — because the version is
 * what makes the URL cache-bustable. Upgrading used to delete the old version's
 * directory immediately, which broke every page already on disk: the artefacts
 * still carried the old path, and nothing re-rendered them. On a real site an
 * upgrade 404'd jQuery, GSAP, Lenis, Splide and the boot script on all six
 * pages at once — the whole site's JavaScript, with no warning and no prompt
 * to re-publish. A publish fixed it, but only for someone who already knew.
 *
 * So the delete belongs at publish, not at upgrade. Publish is the only thing
 * that rewrites those URLs, which makes it the exact moment the old files stop
 * being referenced. Between an upgrade and the next publish both versions sit
 * on disk: the installed one for new renders, the previous one for pages that
 * have not been re-baked yet. The cost is bounded by how many upgrades happen
 * between two publishes, and each version is a bundle, not a library.
 *
 * `publishSite.ts` calls this after the slot swap. Failure is logged and
 * swallowed — leftover files are wasted disk, never a broken page, and a
 * publish must not fail over cleanup.
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '../db/client'
import { listInstalledPlugins } from '../repositories/plugins'

/**
 * Delete every plugin version directory except the installed one.
 *
 * A plugin with no installed record is left entirely alone: uninstall already
 * removes its tree, so anything still here is unexplained, and unexplained is
 * not a good reason to delete from a live volume.
 */
export async function sweepStalePluginVersionAssets(
  db: DbClient,
  uploadsDir: string,
): Promise<{ removed: number }> {
  const pluginsRoot = join(uploadsDir, 'plugins')

  const currentVersion = new Map<string, string>()
  for (const result of await listInstalledPlugins(db)) {
    if (result.kind !== 'ok') continue
    currentVersion.set(result.plugin.id, result.plugin.version)
  }

  let removed = 0
  let pluginDirs: string[]
  try {
    pluginDirs = (await readdir(pluginsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { removed: 0 } // no plugins installed on this site
  }

  for (const pluginId of pluginDirs) {
    const keep = currentVersion.get(pluginId)
    if (!keep) continue
    let versions: string[]
    try {
      versions = (await readdir(join(pluginsRoot, pluginId), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const version of versions) {
      if (version === keep) continue
      await rm(join(pluginsRoot, pluginId, version), { recursive: true, force: true })
      removed += 1
    }
  }
  return { removed }
}
