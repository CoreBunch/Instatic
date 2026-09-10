/**
 * Serving side of the per-site CSS bundles — `/_instatic/css/<bundle>-<hash>.css`.
 *
 * `siteCssBundle.ts` BUILDS the bundle files; this module answers HTTP
 * requests for them. It was extracted from `server/router.ts`, which had no
 * business owning a DB-fallback rebuild walk and its memo — the dispatcher
 * just forwards the path here.
 */

import type { DbClient } from '../db/client'
import { registry } from '@core/module-engine'
import type { CssBundleFile, SiteCssBundleId } from '@core/publisher'
import { toArrayBuffer } from '../binary'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { getPublishVersion, registerVersionedCacheReset } from './publishState'
import { prefetchMediaAssets } from './mediaPrefetch'
import { buildPublishedSiteCssBundle } from './siteCssBundle'
import { readStaticAsset } from './staticArtefact'

/**
 * Serve one of the three site CSS bundle files (reset / framework / style).
 *
 * The URL path is `/_instatic/css/<bundle>-<hash>.css` where `<bundle>` is the
 * logical layer name and `<hash>` is the 12-hex SHA-256 prefix that
 * `buildSiteCssBundle` produces.
 *
 * Disk-first: a full publish bakes every referenced CSS file into the active
 * slot, so this handler reads it straight off disk — no DB, no rebuild. The
 * DB rebuild below is a fallback for preview (pre-publish) or a publish whose
 * disk write failed.
 *
 *  - Browsers / CDNs cache the response for a year (`immutable`).
 *  - When a hash changes (the site, its classes, or a stylesheet was edited),
 *    HTML pages re-render with the new `<link href>` and visitors fetch the
 *    new file exactly once.
 *
 * Stale hash → 404 so the browser falls back to refetching the HTML, which
 * carries the current hash. Returning the new content under the old name
 * would defeat `immutable` caching by serving different bytes for the same
 * URL across the cache lifetime.
 *
 * `reset`/`framework`/`style` are page-invariant; `userStyles` is page-scoped
 * (each stylesheet targets a subset of pages), so the fallback walks the
 * published pages until one produces the requested hash.
 *
 * The DB fallback is memoised by `(bundle, hash)` — the hash is content-derived
 * so an entry can never go stale; it can only stop being requested. Negative
 * results are cached too (a crafted stale-hash URL would otherwise force the
 * full rebuild walk per request). The memo resets when the publish version
 * moves and concurrent first-hits share one in-flight rebuild.
 */
const cssFallbackCache = new Map<string, string | null>()
const CSS_FALLBACK_CACHE_MAX = 256
const cssFallbackInFlight = new Map<string, Promise<string | null>>()
let cssFallbackVersion = -1
registerVersionedCacheReset(() => {
  cssFallbackCache.clear()
  cssFallbackInFlight.clear()
  cssFallbackVersion = -1
})

export async function serveSiteCss(db: DbClient, pathname: string, uploadsDir?: string): Promise<Response | null> {
  const filename = pathname.slice('/_instatic/css/'.length)
  const match = filename.match(/^(reset|framework|style|userStyles)-([a-f0-9]{12})\.css$/)
  if (!match) return null

  const [, requestedBundle, requestedHash] = match
  const bundleId = requestedBundle as SiteCssBundleId

  // Disk-first.
  if (uploadsDir) {
    const bytes = await readStaticAsset(uploadsDir, pathname)
    if (bytes) {
      return cssResponse(toArrayBuffer(bytes), requestedHash)
    }
  }

  // Memoised DB fallback.
  const version = getPublishVersion()
  if (version !== cssFallbackVersion) {
    cssFallbackCache.clear()
    cssFallbackVersion = version
  }
  const cacheKey = `${bundleId}:${requestedHash}`
  const cached = cssFallbackCache.get(cacheKey)
  if (cached !== undefined) {
    return cached === null ? new Response('Not found', { status: 404 }) : cssResponse(cached, requestedHash)
  }

  const inflight = cssFallbackInFlight.get(cacheKey)
  const promise = inflight ?? (async (): Promise<string | null> => {
    try {
      const content = await rebuildSiteCssFromSnapshot(db, bundleId, requestedHash, version)
      if (cssFallbackCache.size >= CSS_FALLBACK_CACHE_MAX) cssFallbackCache.clear()
      cssFallbackCache.set(cacheKey, content)
      return content
    } finally {
      cssFallbackInFlight.delete(cacheKey)
    }
  })()
  if (!inflight) cssFallbackInFlight.set(cacheKey, promise)

  const content = await promise
  return content === null ? new Response('Not found', { status: 404 }) : cssResponse(content, requestedHash)
}

/**
 * Rebuild the requested CSS bundle file from the latest published snapshot.
 * Returns the file body, or `null` when no page (nor the page-agnostic view)
 * produces the requested hash. The page-invariant trio comes from the
 * version-keyed memo, so only `userStyles` does per-page work here.
 */
async function rebuildSiteCssFromSnapshot(
  db: DbClient,
  bundleId: SiteCssBundleId,
  requestedHash: string,
  version: number,
): Promise<string | null> {
  const snapshot = await getLatestSnapshotForVersion(db, version)
  if (!snapshot) return null

  const pages = bundleId === 'userStyles' ? snapshot.site.pages : snapshot.site.pages.slice(0, 1)
  for (const page of pages) {
    const mediaAssets = await prefetchMediaAssets(page, snapshot.site, registry, db)
    const file: CssBundleFile = buildPublishedSiteCssBundle(snapshot.site, registry, page, version, { mediaAssets })[bundleId]
    if (file.hash === requestedHash) return file.content
  }
  // Page-agnostic view (every enabled stylesheet) — covers a hash that
  // predates a scope change but is still referenced somewhere.
  const fallbackMediaAssets = snapshot.site.pages[0]
    ? await prefetchMediaAssets(snapshot.site.pages[0], snapshot.site, registry, db)
    : undefined
  const fallback: CssBundleFile = buildPublishedSiteCssBundle(
    snapshot.site,
    registry,
    undefined,
    version,
    { mediaAssets: fallbackMediaAssets },
  )[bundleId]
  if (fallback.hash === requestedHash) return fallback.content

  return null
}

function cssResponse(body: BodyInit, hash: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${hash}"`,
    },
  })
}
