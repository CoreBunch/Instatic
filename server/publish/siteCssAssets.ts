import type { DbClient } from '../db/client'
import { registry } from '@core/module-engine'
import type { SiteCssBundleId } from '@core/publisher'
import type { Page } from '@core/page-tree'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import { composeTemplateChain, isTemplatePage, resolveNotFoundTemplate, resolveTemplateChain } from '@core/templates'
import { toArrayBuffer } from '../binary'
import { listPublishedPageRuntimeAssets } from '../repositories/publish'
import { buildPublishedSiteCssBundle } from './siteCssBundle'
import { readStaticAsset } from './staticArtefact'
import { getLatestSnapshotForVersion } from './publishedSnapshotCache'
import { createVersionedSingleFlight, getPublishVersion, registerVersionedCacheReset } from './publishState'
import { prefetchMediaAssets } from './mediaPrefetch'

const cssFallbackCache = new Map<string, string | null>()
const cssFallbackInFlight = new Map<string, Promise<string | null>>()
const CSS_FALLBACK_CACHE_MAX = 256
const runtimeManifestMemo = createVersionedSingleFlight<Map<string, PublishedPageRuntimeAssets>>()
let cssFallbackVersion = -1
registerVersionedCacheReset(() => {
  cssFallbackCache.clear()
  cssFallbackInFlight.clear()
  cssFallbackVersion = -1
})

/**
 * Disk-first, immutable CSS assets. The fallback matches every page's actual
 * authored bundle, including template composition and its own runtime manifest.
 * Hashes from previous publishes never receive different bytes under their URL.
 */
export async function serveSiteCss(db: DbClient, pathname: string, uploadsDir?: string): Promise<Response | null> {
  const filename = pathname.slice('/_instatic/css/'.length)
  const match = filename.match(/^(reset|framework|style|userStyles)-([a-f0-9]{12})\.css$/)
  if (!match) return null
  const [, requestedBundle, requestedHash] = match
  const bundleId = requestedBundle as SiteCssBundleId
  if (uploadsDir) {
    const bytes = await readStaticAsset(uploadsDir, pathname)
    if (bytes) return cssResponse(toArrayBuffer(bytes), requestedHash)
  }

  const version = getPublishVersion()
  if (version !== cssFallbackVersion) {
    cssFallbackCache.clear()
    cssFallbackInFlight.clear()
    cssFallbackVersion = version
  }
  const key = `${bundleId}:${requestedHash}`
  const cached = cssFallbackCache.get(key)
  if (cached !== undefined) return cached === null ? notFound() : cssResponse(cached, requestedHash)
  let promise = cssFallbackInFlight.get(key)
  if (!promise) {
    promise = rebuildSiteCssFromSnapshot(db, bundleId, requestedHash, version)
    cssFallbackInFlight.set(key, promise)
  }
  try {
    const content = await promise
    // An older request can finish after publish. It must not poison the new
    // version's positive or negative cache, or delete its replacement loader.
    if (getPublishVersion() === version && cssFallbackVersion === version) {
      if (cssFallbackCache.size >= CSS_FALLBACK_CACHE_MAX) cssFallbackCache.clear()
      cssFallbackCache.set(key, content)
    }
    return content === null ? notFound() : cssResponse(content, requestedHash)
  } finally {
    if (cssFallbackInFlight.get(key) === promise) cssFallbackInFlight.delete(key)
  }
}

async function rebuildSiteCssFromSnapshot(
  db: DbClient,
  bundleId: SiteCssBundleId,
  requestedHash: string,
  version: number,
): Promise<string | null> {
  const snapshot = await getLatestSnapshotForVersion(db, version)
  if (!snapshot) return null
  const { site } = snapshot
  const manifests = await runtimeManifestMemo.get(version, () => listPublishedPageRuntimeAssets(db))
  const candidates: Array<{ page: Page; manifestPageId: string }> = []
  const pageChain = resolveTemplateChain(site, { kind: 'page' })
  const notFoundPage = resolveNotFoundTemplate(site)
  const tableSlugs = new Set<string>()
  for (const page of site.pages) {
    // Raw pages are also baked before composition. Retain their current
    // assets, while never recreating the former all-site union stylesheet.
    candidates.push({ page, manifestPageId: page.id })
    if (!isTemplatePage(page) || page.id === notFoundPage?.id) {
      const merged = composeTemplateChain(pageChain, { kind: 'page', page })
      if (merged !== page) candidates.push({ page: merged, manifestPageId: page.id })
    }
    if (isTemplatePage(page) && page.template?.target.kind === 'postTypes') {
      for (const slug of page.template.target.tableSlugs) tableSlugs.add(slug)
    }
  }
  for (const tableSlug of tableSlugs) {
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug })
    const innermost = chain.at(-1)
    if (innermost) candidates.push({ page: composeTemplateChain(chain, { kind: 'entry' }), manifestPageId: innermost.id })
  }
  for (const { page, manifestPageId } of candidates) {
    const mediaAssets = await prefetchMediaAssets(page, site, registry, db)
    const file = buildPublishedSiteCssBundle(site, registry, page, version, {
      mediaAssets,
      runtimeAssets: manifests?.get(manifestPageId),
    })[bundleId]
    if (file.hash === requestedHash) return file.content
    if (bundleId === 'reset' || bundleId === 'framework') break
  }
  return null
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
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
