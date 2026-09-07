/**
 * Site CSS bundle — server-side builder.
 *
 * Builds the three external CSS files served at `/_instatic/css/<filename>` for
 * every published page. See `src/core/publisher/siteCssBundle.ts` for the type
 * definitions and the cache strategy rationale (hashed filenames + immutable
 * cache headers).
 *
 * This file lives under `server/cms/` because it depends on `node:crypto` for
 * content hashing — that import is unavailable in the editor's app build, so
 * the implementation is server-only.
 *
 * Two entry points, two cost profiles:
 *
 * - `buildSiteCssBundle` rebuilds all four files from scratch. The `framework`
 *   file requires walking EVERY page's node tree (`collectSiteModuleAssets` in
 *   `siteModuleAssets.ts`) to harvest module CSS — work that scales with
 *   whole-site size, not the rendered page. Callers that pass draft / arbitrary sites at the live
 *   publish version (preview, AI render, the CSS-route fallback) use this:
 *   memoising across them would cross-contaminate unpublished content.
 *
 * - `buildPublishedSiteCssBundle` shares page-invariant files for each immutable
 *   projected release document at a publish version. Different languages and
 *   releases have independent cache entries. Only page-scoped userStyles are
 *   rebuilt per call.
 */

import { createHash } from 'node:crypto'
import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import {
  PUBLISHER_RESET_CSS,
  collectClassCSS,
  collectSiteStyleBackgroundImagePaths,
  buildSiteFrameworkCss,
  collectUserStylesheetCss,
} from '@core/publisher'
import type {
  CssBundleFile,
  ResponsiveCssOptions,
  SiteCssBundle,
  SiteCssBundleId,
} from '@core/publisher'
import { collectSiteModuleAssets } from './siteModuleAssets'
import { getPublishVersion, registerVersionedCacheReset } from './publishState'

/**
 * The three page-invariant bundle files: they depend only on `site` + registry,
 * never on the page being rendered. `userStyles` is excluded — it is page-scoped.
 */
type PageInvariantBundles = Pick<SiteCssBundle, 'reset' | 'framework' | 'style'>

/**
 * Build the four site CSS files from a `SiteDocument`.
 *
 * `reset`, `framework`, and `style` are page-invariant — they depend only on
 * the site + registry. `userStyles` is page-scoped: each stylesheet's
 * `SiteStyleRuntimeConfig` decides whether it targets `page`, and `priority`
 * orders the cascade. Passing different pages therefore yields different
 * `userStyles` content (and hash); omitting `page` includes every enabled
 * stylesheet (authoring/export view).
 *
 * Determinism + content-hashed filenames mean two calls with the same inputs
 * always return identical filenames. This rebuilds all four files every call;
 * the published-render hot path uses `buildPublishedSiteCssBundle` instead,
 * which memoises the page-invariant trio by publish version + site object.
 */
export function buildSiteCssBundle(
  site: SiteDocument,
  registry: IModuleRegistry,
  page?: Page,
  options: ResponsiveCssOptions = {},
): SiteCssBundle {
  return {
    ...computePageInvariantBundles(site, registry, options),
    userStyles: makeBundleFile('userStyles', collectUserStylesheetCss(site, page)),
  }
}

/**
 * Reuse page-invariant CSS for a stable projected release document. The route
 * context cache preserves document identity across requests; separate locales
 * and frozen releases never reuse each other's framework or class CSS.
 */
export function buildPublishedSiteCssBundle(
  site: SiteDocument,
  registry: IModuleRegistry,
  page?: Page,
  publishVersion: number = getPublishVersion(),
  options: ResponsiveCssOptions = {},
): SiteCssBundle {
  return {
    ...memoizedPageInvariantBundles(site, registry, publishVersion, options),
    userStyles: makeBundleFile('userStyles', collectUserStylesheetCss(site, page)),
  }
}

/** Build the three page-invariant bundle files from scratch. */
function computePageInvariantBundles(
  site: SiteDocument,
  registry: IModuleRegistry,
  options: ResponsiveCssOptions,
): PageInvariantBundles {
  return {
    reset: makeBundleFile('reset', PUBLISHER_RESET_CSS),
    framework: makeBundleFile('framework', buildFrameworkCss(site, registry)),
    style: makeBundleFile('style', collectClassCSS(site, options)),
  }
}

// Immutable document identity separates simultaneous locale releases. Version
// and media signatures invalidate dependent publication and asset changes.
let pageInvariantCache = new WeakMap<SiteDocument, { version: number; mediaSignature: string; bundles: PageInvariantBundles }>()
registerVersionedCacheReset(() => {
  pageInvariantCache = new WeakMap()
})

/**
 * Return the page-invariant bundles for `version`, computing them once and
 * reusing the cached files on later renders of the same publish version.
 */
function memoizedPageInvariantBundles(
  site: SiteDocument,
  registry: IModuleRegistry,
  version: number,
  options: ResponsiveCssOptions,
): PageInvariantBundles {
  const mediaSignature = styleMediaSignature(site, options)
  const cached = pageInvariantCache.get(site)
  if (cached && cached.version === version && cached.mediaSignature === mediaSignature) {
    return cached.bundles
  }
  const bundles = computePageInvariantBundles(site, registry, options)
  pageInvariantCache.set(site, { version, mediaSignature, bundles })
  return bundles
}

function styleMediaSignature(site: SiteDocument, options: ResponsiveCssOptions): string {
  if (!options.mediaAssets || options.mediaAssets.size === 0) return ''
  const paths = collectSiteStyleBackgroundImagePaths(site)
  if (paths.size === 0) return ''

  const parts: string[] = []
  for (const path of [...paths].sort()) {
    const media = options.mediaAssets.get(path)
    if (!media || media.variants.length === 0) continue
    parts.push(`${path}=${media.variants.map((v) => `${v.width}:${v.path}`).join('|')}`)
  }
  return parts.join(';')
}

/**
 * Build the `framework.css` body: site-wide platform CSS plus any plugin
 * module CSS used anywhere on the site.
 */
function buildFrameworkCss(site: SiteDocument, registry: IModuleRegistry): string {
  const frameworkCss = buildSiteFrameworkCss(site)
  const moduleCss = Array.from(collectSiteModuleAssets(site, registry).cssMap.values()).join('\n')
  return [frameworkCss, moduleCss].filter(Boolean).join('\n')
}

/**
 * Wrap a CSS body in a `CssBundleFile`. The hash is content-derived so
 * filenames are stable across servers, processes, and process restarts —
 * good for CDN cache reuse.
 *
 * 12-hex-char SHA-256 prefix = 48 bits of entropy ≈ 2.8e14 distinct values.
 * Collision-free for any realistic CMS site count.
 */
function makeBundleFile(
  bundle: SiteCssBundleId,
  content: string,
): CssBundleFile {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12)
  return {
    bundle,
    filename: `${bundle}-${hash}.css`,
    hash,
    content,
  }
}
