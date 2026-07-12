/**
 * Site plugin revision retention — generated packages under
 * `uploads/plugins/site.<id>/<version>/` accumulate one dir per build.
 * Policy (design: docs/features/site-plugins.md → "Cleanup And Retention"):
 *
 *   - keep the active revision;
 *   - keep the immediately previous revision (the `Rollback to previous
 *     revision` target — source-level rollback is impossible once the
 *     draft has moved on, so the artifact is the only rollback);
 *   - delete older revisions AFTER activation and the coupled republish
 *     (when required) succeed — callers sequence that; this module only
 *     sweeps.
 *
 * Whole-plugin teardown (uninstall) rides the existing
 * `removeAllPluginAssets` sweep, not this module.
 */
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPathWithin } from '../../util/pathWithin'

const VERSION_COUNTER = /^1\.0\.(\d+)\+/

/** Keep the active version + the immediately previous one; delete the rest. */
export async function sweepSitePluginRevisions(
  uploadsDir: string,
  pluginId: string,
  activeVersion: string,
): Promise<string[]> {
  const pluginDir = join(uploadsDir, 'plugins', pluginId)
  assertPathWithin(uploadsDir, pluginDir)
  let entries: string[]
  try {
    entries = await readdir(pluginDir)
  } catch {
    return [] // nothing built yet
  }
  const counter = (version: string): number => {
    const match = VERSION_COUNTER.exec(version)
    return match ? Number(match[1]) : -1
  }
  const activeCounter = counter(activeVersion)
  const keep = new Set([activeVersion])
  const previous = entries
    .filter((v) => v !== activeVersion && counter(v) >= 0 && counter(v) < activeCounter)
    .sort((a, b) => counter(b) - counter(a))[0]
  if (previous) keep.add(previous)

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

/** The rollback target — the retained revision immediately below `activeVersion`. */
export async function previousSitePluginRevision(
  uploadsDir: string,
  pluginId: string,
  activeVersion: string,
): Promise<string | null> {
  const pluginDir = join(uploadsDir, 'plugins', pluginId)
  assertPathWithin(uploadsDir, pluginDir)
  let entries: string[]
  try {
    entries = await readdir(pluginDir)
  } catch {
    return null
  }
  const counter = (version: string): number => {
    const match = VERSION_COUNTER.exec(version)
    return match ? Number(match[1]) : -1
  }
  const activeCounter = counter(activeVersion)
  return (
    entries
      .filter((v) => v !== activeVersion && counter(v) >= 0 && counter(v) < activeCounter)
      .sort((a, b) => counter(b) - counter(a))[0] ?? null
  )
}
