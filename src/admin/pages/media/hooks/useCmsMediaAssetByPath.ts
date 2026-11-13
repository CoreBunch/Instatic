/**
 * useCmsMediaAssetByPath — fetch the CMS media asset whose `publicPath`
 * matches a given URL, with module-level memoisation so dozens of image
 * modules on the same page share one round-trip per unique path.
 *
 * Why publicPath, not id? The Image / Video modules store the asset's
 * public URL (`/uploads/<storage>`) on the prop — the same value used as
 * the `src` attribute. The server-side `prefetchMediaAssets` pre-pass
 * also joins by `public_path`, so editor preview and published HTML
 * resolve identically.
 *
 * Cache key: the `publicPath` string. The first hook call for a given
 * path fires `listCmsMediaAssets()` (one round trip) and caches the
 * matched asset; subsequent calls (or remounts) hit the cache. Cache
 * invalidates on `refreshCmsMediaAssetCache()` — call after a replace /
 * delete so stale rows don't linger.
 */
import { use, useEffect, useState } from 'react'
import { listCmsMediaAssets, type CmsMediaAsset } from '@core/persistence/cmsMedia'
import { CanvasPreviewReadinessContext } from '@site/canvas/CanvasPreviewReadiness'

// Module-level cache, shared across every consumer, keyed by BOTH the
// asset's publicPath and its id (ids and paths can never collide — ids are
// nanoid strings, paths start with `/`). CmsMediaAsset objects are small
// (< 1 KB each), so a Map of every asset the user has touched in this
// session is negligible memory.
const cache = new Map<string, CmsMediaAsset>()
let listPromise: Promise<CmsMediaAsset[]> | null = null
const subscribers = new Set<() => void>()

interface CachedAssetSnapshot {
  key: string
  assets: ReadonlyMap<string, CmsMediaAsset>
}

const EMPTY_PATHS: string[] = []
const EMPTY_ASSETS = new Map<string, CmsMediaAsset>()

function notifySubscribers(): void {
  for (const sub of subscribers) sub()
}

function publicPathsKey(publicPaths: readonly string[]): string {
  return [...new Set(publicPaths)].sort().join('\0')
}

function pathsFromKey(key: string): string[] {
  return key ? key.split('\0') : EMPTY_PATHS
}

function cachedAssetsForKey(key: string): ReadonlyMap<string, CmsMediaAsset> {
  if (!key) return EMPTY_ASSETS

  const assets = new Map<string, CmsMediaAsset>()
  for (const path of pathsFromKey(key)) {
    const asset = cache.get(path)
    if (asset) assets.set(path, asset)
  }
  return assets
}

function cacheAssetList(assets: readonly CmsMediaAsset[]): void {
  for (const asset of assets) {
    cache.set(asset.publicPath, asset)
    cache.set(asset.id, asset)
  }
  notifySubscribers()
}

function ensureList(): Promise<CmsMediaAsset[]> {
  if (listPromise) return listPromise
  listPromise = listCmsMediaAssets()
    .then((assets) => {
      cacheAssetList(assets)
      return assets
    })
    .catch((err) => {
      // Reset so a retry can re-issue the fetch.
      listPromise = null
      throw err
    })
  return listPromise
}

/**
 * Drop the cache so the next consumer re-fetches. Call after a
 * mutation that may have changed the asset list (upload, replace,
 * delete) if you need stale rows out of the editor preview.
 */
export function refreshCmsMediaAssetCache(): void {
  cache.clear()
  listPromise = null
  notifySubscribers()
}

export function primeCmsMediaAssetCache(asset: CmsMediaAsset): void {
  cacheAssetList([asset])
}

export function useCmsMediaAssetByPath(publicPath: string | null | undefined): CmsMediaAsset | null {
  const assets = useCmsMediaAssetsByPath(publicPath ? [publicPath] : EMPTY_PATHS)
  return publicPath ? assets.get(publicPath) ?? null : null
}

/**
 * The whole media library as an id-and-path-keyed lookup — the canvas-side
 * counterpart of the publisher's `prefetchMediaAssets` map. Attached to the
 * template render context so `format: 'media'` bindings resolve bare asset
 * references (custom media cells store the id) in the editor exactly like
 * they do on the published page. One shared `listCmsMediaAssets()` round
 * trip per session, reusing the same module cache as the by-path hooks.
 */
export function useCmsMediaAssetLookup(): ReadonlyMap<string, CmsMediaAsset> {
  const previewReadiness = use(CanvasPreviewReadinessContext)
  const [snapshot, setSnapshot] = useState<ReadonlyMap<string, CmsMediaAsset>>(
    () => new Map(cache),
  )

  useEffect(() => {
    let canceled = false
    const updateSnapshot = () => {
      if (!canceled) setSnapshot(new Map(cache))
    }
    subscribers.add(updateSnapshot)

    // `ensureList` memoises its promise, so this is one network round trip
    // per session no matter how many surfaces mount the lookup.
    const request = ensureList()
    previewReadiness?.track(request)
    void request
      .then(updateSnapshot)
      .catch(() => { /* swallow — bindings fall back to their static props */ })

    return () => {
      canceled = true
      subscribers.delete(updateSnapshot)
    }
  }, [previewReadiness])

  return snapshot
}

export function useCmsMediaAssetsByPath(publicPaths: readonly string[]): ReadonlyMap<string, CmsMediaAsset> {
  const previewReadiness = use(CanvasPreviewReadinessContext)
  const key = publicPathsKey(publicPaths)
  const [snapshot, setSnapshot] = useState<CachedAssetSnapshot>(() => ({
    key,
    assets: cachedAssetsForKey(key),
  }))
  const currentAssets = snapshot.key === key ? snapshot.assets : cachedAssetsForKey(key)

  useEffect(() => {
    const paths = pathsFromKey(key)
    if (paths.length === 0) return

    let canceled = false

    const updateSnapshot = () => {
      if (!canceled) setSnapshot({ key, assets: cachedAssetsForKey(key) })
    }

    updateSnapshot()
    subscribers.add(updateSnapshot)

    if (!paths.every((path) => cache.has(path))) {
      const request = ensureList()
      previewReadiness?.track(request)
      void request
        .then(updateSnapshot)
        .catch(() => { /* swallow — editor still renders raw urls */ })
    }

    return () => {
      canceled = true
      subscribers.delete(updateSnapshot)
    }
  }, [key, previewReadiness])

  return currentAssets
}
