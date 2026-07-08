/**
 * Server-side media-asset pre-fetch.
 *
 * Walks a page tree, finds every prop whose module-schema control type is
 * `image` or `media`, collects the local `/uploads/<storage>` paths, batch-
 * fetches the matching `media_assets` rows, and returns a map keyed by
 * `public_path` → asset. The publisher attaches the resolved assets to each
 * node's `props._resolvedMediaByKey` (keyed by prop key) before calling
 * `render()` so the pure render function can emit responsive markup
 * (srcset / sizes / BlurHash) without any I/O of its own.
 *
 * Why look up by `public_path`, not asset id?
 *   - The module prop stores the raw path (e.g. `/uploads/abc-hero.png`)
 *     today; no schema change required.
 *   - `replaceMediaAssetBinary` keeps the same `public_path` so existing
 *     page references stay valid across a file swap. Fetching by path
 *     transparently picks up the new variant list.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { collectNodeBackgroundImagePaths, collectSiteStyleBackgroundImagePaths } from '@core/publisher'
import { walkRenderTree } from './renderTreeWalk'
import type { DbClient } from '../db/client'
import type { MediaAsset } from '../repositories/media'
import {
  MEDIA_ASSET_COLUMNS,
  mapMediaAssetRow,
  type MediaAssetRow,
} from '../repositories/mediaAssetMapping'
import { materializeAssetMapForClient } from './mediaPresentation'

/** Map keyed by the asset's `public_path` for O(1) lookup at render time. */
type MediaAssetMap = Map<string, MediaAsset>

/**
 * Collect every `/uploads/...` path referenced by an image/media-typed prop
 * across the page tree.
 */
function collectMediaPaths(page: Page, site: SiteDocument, registry: IModuleRegistry): Set<string> {
  const paths = new Set<string>()
  // Descend into referenced VC definition trees so an image/media prop inside a
  // VC body is resolved too (ISS-022).
  walkRenderTree(page.nodes, page.rootNodeId, site, (node) => {
    const def = registry.get(node.moduleId)
    if (!def) return
    collectNodeBackgroundImagePaths(node, paths)
    for (const [propKey, control] of Object.entries(def.schema)) {
      // Only `image` / `media` controls participate in the responsive
      // pipeline. Plain `text` URL fields (rare) aren't auto-upgraded.
      if (control.type !== 'image' && control.type !== 'media') continue
      const value = (node.props as Record<string, unknown> | undefined)?.[propKey]
      if (typeof value !== 'string' || !value.startsWith('/uploads/')) continue
      paths.add(value)
    }
  })
  for (const path of collectSiteStyleBackgroundImagePaths(site)) {
    paths.add(path)
  }
  return paths
}

/**
 * Fetch every media asset referenced by image / media props in the page
 * tree. Returns an empty map for pages that reference no local uploads
 * (purely external URLs, or no media modules at all).
 *
 * One batched IN-query covers all paths regardless of page size.
 */
export async function prefetchMediaAssets(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
  db: DbClient,
): Promise<MediaAssetMap> {
  const map = new Map<string, MediaAsset>()
  const paths = collectMediaPaths(page, site, registry)
  if (paths.size === 0) return map

  // `collectMediaPaths` already returns a Set, so the paths are unique.
  const pathsToFetch = [...paths]
  const placeholders = pathsToFetch.map((_, i) =>
    db.dialect === 'postgres' ? `$${i + 1}` : '?'
  ).join(', ')
  // Bespoke batched-by-`public_path` SELECT (the render path resolves by stored
  // URL, not asset id, and legitimately skips the folder-id join). It maps
  // through the SAME canonical `mapMediaAssetRow` as the repository, so the
  // published page and the admin see one identical asset shape — including
  // storageAdapterId, externallyHosted, and the variants' storagePath /
  // storageAdapterId derivation.
  const { rows } = await db.unsafe<MediaAssetRow>(
    `select ${MEDIA_ASSET_COLUMNS}
     from media_assets
     where public_path in (${placeholders}) and deleted_at is null`,
    pathsToFetch,
  )
  const byPath = new Map(rows.map(r => [r.public_path, r]))
  for (const path of pathsToFetch) {
    const row = byPath.get(path)
    if (row) map.set(path, mapMediaAssetRow(row))
  }
  // Apply the `media.url.transform` filter chain to every asset's URLs
  // (publicPath + variants[*].path). The map KEY stays the page tree's
  // stored token so the renderer's O(1) lookup still works; the VALUE is
  // rewritten so transformer plugins (passive CDN, image-CDN) take effect
  // on the published page AND the editor preview iframe in one place.
  return materializeAssetMapForClient(map)
}
