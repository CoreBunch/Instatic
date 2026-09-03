/**
 * Site plugin revision retention — generated packages under
 * `uploads/plugins/site.<id>/<version>/` accumulate one dir per build.
 * Policy (design: docs/features/site-plugins.md → "Cleanup And Retention"):
 *
 *   - keep the RETAINED_REVISIONS highest builds, plus whatever is active
 *     (a rollback can make an older build the active one);
 *   - every retained build is a rollback target — the IDE's version picker
 *     lists them. Source rolls forward only, so the artifact is the only
 *     rollback;
 *   - delete the rest AFTER activation and the coupled republish (when
 *     required) succeed — callers sequence that; this module only sweeps.
 *
 * Whole-plugin teardown (uninstall) rides the existing
 * `removeAllPluginAssets` sweep, not this module.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'

export const RETAINED_REVISIONS = 5

const VERSION_COUNTER = /^1\.0\.(\d+)\+/

export interface SitePluginRevision {
  version: string
  /** Build time, epoch ms — the package directory's mtime. */
  builtAt: number
}

function counterOf(version: string): number {
  const match = VERSION_COUNTER.exec(version)
  return match ? Number(match[1]) : -1
}

/** Directory entries of the plugin's revision tree; versions newest first. */
async function revisionEntries(
  uploadsDir: string,
  pluginId: string,
): Promise<{ pluginDir: string; entries: string[]; versions: string[] }> {
  const pluginDir = join(uploadsDir, 'plugins', pluginId)
  assertPathWithin(uploadsDir, pluginDir)
  let entries: string[]
  try {
    entries = await readdir(pluginDir)
  } catch {
    entries = [] // nothing built yet
  }
  const versions = entries
    .filter((entry) => counterOf(entry) >= 0)
    .sort((a, b) => counterOf(b) - counterOf(a))
  return { pluginDir, entries, versions }
}

/** Retained builds, newest first — the rollback targets. */
export async function listSitePluginRevisions(
  uploadsDir: string,
  pluginId: string,
): Promise<SitePluginRevision[]> {
  const { pluginDir, versions } = await revisionEntries(uploadsDir, pluginId)
  const revisions: SitePluginRevision[] = []
  for (const version of versions) {
    const dir = join(pluginDir, version)
    assertPathWithin(uploadsDir, dir)
    const info = await stat(dir)
    revisions.push({ version, builtAt: Math.round(info.mtimeMs) })
  }
  return revisions
}

/**
 * Keep the RETAINED_REVISIONS highest builds plus the active one; delete
 * everything else (including entries that are not version-shaped).
 */
export async function sweepSitePluginRevisions(
  uploadsDir: string,
  pluginId: string,
  activeVersion: string,
): Promise<string[]> {
  const { pluginDir, entries, versions } = await revisionEntries(uploadsDir, pluginId)
  const keep = new Set([activeVersion, ...versions.slice(0, RETAINED_REVISIONS)])

  const removed: string[] = []
  for (const entry of entries) {
    if (keep.has(entry)) continue
    const target = join(pluginDir, entry)
    assertPathWithin(uploadsDir, target)
    await rm(target, { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}
