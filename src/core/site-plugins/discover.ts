/**
 * Site plugin discovery — pure function over the draft's `SiteFile[]`.
 * Groups `type: 'plugin'` files by the `plugins/<local-id>/` folder
 * convention and validates local ids before anything downstream runs.
 */
import type { SiteFile } from '@core/files/schemas'
import { SITE_PLUGIN_LOCAL_ID_PATTERN, SITE_PLUGIN_SOURCE_ROOT } from './schemas'

export interface DiscoveredSitePlugin {
  localId: string
  /** All 'plugin' files under plugins/<localId>/, paths intact, sorted by path. */
  files: SiteFile[]
  /** The plugins/<localId>/plugin.json file, or null when missing. */
  manifestFile: SiteFile | null
}

export function discoverSitePlugins(files: readonly SiteFile[]): DiscoveredSitePlugin[] {
  const byLocalId = new Map<string, SiteFile[]>()
  for (const file of files) {
    if (file.type !== 'plugin') continue
    if (!file.path.startsWith(SITE_PLUGIN_SOURCE_ROOT)) continue
    const [localId] = file.path.slice(SITE_PLUGIN_SOURCE_ROOT.length).split('/')
    if (!localId) continue
    if (!SITE_PLUGIN_LOCAL_ID_PATTERN.test(localId)) {
      throw new Error(
        `Invalid site plugin local id "${localId}" — must be a single lowercase ` +
          `kebab-case segment (a-z, 0-9, hyphens; starts with a letter).`,
      )
    }
    const bucket = byLocalId.get(localId) ?? []
    bucket.push(file)
    byLocalId.set(localId, bucket)
  }
  return [...byLocalId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([localId, pluginFiles]) => {
      const sorted = [...pluginFiles].sort((a, b) => a.path.localeCompare(b.path))
      return {
        localId,
        files: sorted,
        manifestFile:
          sorted.find((f) => f.path === `${SITE_PLUGIN_SOURCE_ROOT}${localId}/plugin.json`) ?? null,
      }
    })
}
