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
import {
  collectNodeBackgroundImagePaths,
  collectSiteStyleBackgroundImagePaths,
  type ResolvedLoopRenderData,
} from '@core/publisher'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
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

interface MediaPrefetchOptions {
  templateContext?: TemplateRenderDataContext
  loopData?: ReadonlyMap<string, ResolvedLoopRenderData>
}

/**
 * Collect every `/uploads/...` path referenced by an image/media-typed prop
 * in ONE page's tree.
 *
 * Site-level style backgrounds are deliberately NOT included: they belong to
 * the site, not to any page that happens to be rendering. The prefetch adds
 * them separately, and the media-usage lookup attributes them to the site so
 * a delete warning can say where a file is actually used.
 */
export function collectPageMediaPaths(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): Set<string> {
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
  return paths
}

/** The page's own references plus the site-level style backgrounds. */
function collectMediaPaths(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
): Set<string> {
  const paths = collectPageMediaPaths(page, site, registry)
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
  options: MediaPrefetchOptions = {},
): Promise<MediaAssetMap> {
  const map = new Map<string, MediaAsset>()
  const paths = collectMediaPaths(page, site, registry)
  const entryReferences = collectEntryMediaReferences(options)
  if (paths.size === 0 && entryReferences.size === 0) return map

  // `collectMediaPaths` and `collectEntryMediaReferences` both return Sets,
  // so the lookup values are unique. Entry references are queried against
  // both `id` and `public_path`: multi-media cells store ids, while plugin or
  // imported entry arrays may already carry public paths.
  const pathsToFetch = [...paths]
  const entryReferencesToFetch = [...entryReferences]
  const allReferences = [...new Set([...pathsToFetch, ...entryReferencesToFetch])]
  // Bespoke batched-by-`public_path` SELECT (the render path resolves by stored
  // URL, not asset id, and legitimately skips the folder-id join). It maps
  // through the SAME canonical `mapMediaAssetRow` as the repository, so the
  // published page and the admin see one identical asset shape — including
  // storageAdapterId, externallyHosted, and the variants' storagePath /
  // storageAdapterId derivation.
  let rows: MediaAssetRow[]
  if (entryReferencesToFetch.length === 0) {
    const placeholders = pathsToFetch.map((_, i) =>
      db.dialect === 'postgres' ? `$${i + 1}` : '?'
    ).join(', ')
    const result = await db.unsafe<MediaAssetRow>(
      `select ${MEDIA_ASSET_COLUMNS}
       from media_assets
       where public_path in (${placeholders}) and deleted_at is null`,
      pathsToFetch,
    )
    rows = result.rows
  } else {
    const pathPlaceholders = allReferences.map((_, i) =>
      db.dialect === 'postgres' ? `$${i + 1}` : '?'
    ).join(', ')
    const idPlaceholders = allReferences.map((_, i) =>
      db.dialect === 'postgres' ? `$${allReferences.length + i + 1}` : '?'
    ).join(', ')
    const result = await db.unsafe<MediaAssetRow>(
      `select ${MEDIA_ASSET_COLUMNS}
       from media_assets
       where (public_path in (${pathPlaceholders}) or id in (${idPlaceholders}))
         and deleted_at is null`,
      [...allReferences, ...allReferences],
    )
    rows = result.rows
  }
  const byPath = new Map(rows.map(r => [r.public_path, r]))
  const byId = new Map(rows.map(r => [r.id, r]))
  for (const reference of allReferences) {
    const row = byPath.get(reference) ?? byId.get(reference)
    if (!row) continue
    const asset = mapMediaAssetRow(row)
    map.set(reference, asset)
    map.set(asset.publicPath, asset)
  }
  // Apply the `media.url.transform` filter chain to every asset's URLs
  // (publicPath + variants[*].path). The map KEY stays the page tree's
  // stored token so the renderer's O(1) lookup still works; the VALUE is
  // rewritten so transformer plugins (passive CDN, image-CDN) take effect
  // on the published page AND the editor preview iframe in one place.
  return materializeAssetMapForClient(map)
}

/**
 * Media references carried by the ENTRY data rather than by a node prop.
 *
 * A bound image (`<img src="{currentEntry.featuredMedia}">`) stores the
 * binding token in its prop, so `collectMediaPaths` — which only recognises a
 * literal `/uploads/...` — never sees it. The path lives in the entry's
 * fields, and it has to be collected from there or the asset is never
 * fetched.
 *
 * Two shapes qualify, and nothing else:
 *
 *   - any string inside an ARRAY — a multi-media cell, every element of which
 *     is a reference (an id, or already a public path);
 *   - a SCALAR string that is an upload path — `featuredMedia` and
 *     `featuredMediaPath` carry the resolved `/uploads/...` URL.
 *
 * The scalar case is deliberately narrow. Collecting every scalar string
 * would drag an entry's whole prose surface into the IN-list; requiring the
 * `/uploads/` prefix picks out exactly the resolved media cells.
 *
 * Missing this case is not cosmetic. Without the asset the image module has
 * no library record to read, and since alt text comes exclusively from the
 * library, every bound image published with an EMPTY alt — plus no srcset and
 * no intrinsic width/height. That is the ordinary CMS pattern: one image per
 * entry, on every entry route and in every loop row.
 */
function collectEntryMediaReferences(options: MediaPrefetchOptions): Set<string> {
  const references = new Set<string>()
  const visit = (value: unknown, insideArray: boolean): void => {
    if (typeof value === 'string') {
      if (value && (insideArray || value.startsWith('/uploads/'))) references.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, true)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const child of Object.values(value as Record<string, unknown>)) {
      visit(child, insideArray)
    }
  }

  for (const entry of options.templateContext?.entryStack ?? []) {
    visit(entry.fields, false)
  }
  for (const data of options.loopData?.values() ?? []) {
    for (const item of data.items) visit(item.fields, false)
  }
  return references
}
