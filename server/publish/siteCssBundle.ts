/**
 * Site CSS bundle — server-side builder.
 *
 * Builds the four external CSS files served at `/_instatic/css/<filename>` for
 * every published page. See `src/core/publisher/siteCssBundle.ts` for the type
 * definitions and the cache strategy rationale (hashed filenames + immutable
 * cache headers).
 *
 * This file lives under `server/publish/` because it depends on `node:crypto` for
 * content hashing — that import is unavailable in the editor's app build, so
 * the implementation is server-only.
 *
 * Two entry points, two cost profiles:
 *
 * - `buildSiteCssBundle` rebuilds all four files from scratch. The `framework`
 *   file requires walking EVERY page's node tree (`collectSiteModuleAssets` in
 *   `siteModuleAssets.ts`) to harvest module CSS — work that scales with
 *   whole-site size, not the rendered page. Callers that pass draft / arbitrary
 *   sites at the live publish version (preview, AI render) use this:
 *   memoising across them would cross-contaminate unpublished content.
 *
 * - `buildPublishedSiteCssBundle` is the hot path for the published-snapshot
 *   renderer (`publicRenderer.ts`) and CSS-route fallback. There the site content is fixed for a
 *   given publish version, so the page-invariant files (reset / framework)
 *   are memoised by `publishVersion` and reused across
 *   every render at that version — the expensive all-pages walk runs once per
 *   publish, not once per request. `style` and `userStyles` are rebuilt for the
 *   effective page, media variants and emitted scripts on every call.
 */

import { createHash } from 'node:crypto'
import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import {
  PUBLISHER_RESET_CSS,
  collectClassCSS,
  buildSiteFrameworkCss,
  collectUserStylesheetCss,
} from '@core/publisher'
import type {
  CssBundleFile,
  ClassCssOptions,
  SiteCssBundle,
  SiteCssBundleId,
} from '@core/publisher'
import { collectSiteModuleAssets } from './siteModuleAssets'
import { getPublishVersion, registerVersionedCacheReset } from './publishState'

/**
 * Platform bundles depend only on `site` + registry. Both authored layers are
 * page-scoped and deliberately excluded from the version-wide memo.
 */
type PageInvariantBundles = Pick<SiteCssBundle, 'reset' | 'framework'>

/**
 * Build the four site CSS files from a `SiteDocument`.
 *
 * `reset` and `framework` are site-wide. `style` collects the effective page's
 * reachable class rules; `userStyles` selects enabled, scoped stylesheets.
 *
 * Determinism + content-hashed filenames mean two calls with the same inputs
 * always return identical filenames. This rebuilds all four files every call;
 * the published-render hot path uses `buildPublishedSiteCssBundle` instead,
 * which memoises the platform pair by publish version.
 */
export function buildSiteCssBundle(
  site: SiteDocument,
  registry: IModuleRegistry,
  page: Page,
  options: ClassCssOptions = {},
): SiteCssBundle {
  return {
    ...computePageInvariantBundles(site, registry),
    style: makeBundleFile('style', collectClassCSS(site, page, options)),
    userStyles: makeBundleFile('userStyles', collectUserStylesheetCss(site, page)),
  }
}

/**
 * Published-render variant of `buildSiteCssBundle`. Memoises the two
 * page-invariant files (reset / framework) by `publishVersion`, so
 * the O(all-pages) module-CSS walk runs once per publish version instead of
 * once per render. Both authored layers are rebuilt per page and per call.
 *
 * Memo key = publish version ALONE. The published site content is fixed for a
 * given version: `publishDraftSite` is the only snapshot writer and it bumps
 * the version right after committing, and incremental row publishes never
 * write the site document (they bump too, which just re-primes the memo with
 * identical content). The publish-time bake renders the NEXT version's content
 * before the bump, so it passes `nextPublishVersion` explicitly — its entries
 * can never collide with pre-publish renders at the old version.
 *
 * Safe ONLY for published-snapshot content. Callers that pass draft /
 * arbitrary sites (preview, AI render) must use `buildSiteCssBundle` —
 * sharing a render-path cache across them would serve stale CSS.
 */
export function buildPublishedSiteCssBundle(
  site: SiteDocument,
  registry: IModuleRegistry,
  page: Page,
  publishVersion: number = getPublishVersion(),
  options: ClassCssOptions = {},
): SiteCssBundle {
  return {
    ...memoizedPageInvariantBundles(site, registry, publishVersion),
    style: makeBundleFile('style', collectClassCSS(site, page, options)),
    userStyles: makeBundleFile('userStyles', collectUserStylesheetCss(site, page)),
  }
}

/** Build the two page-invariant bundle files from scratch. */
function computePageInvariantBundles(
  site: SiteDocument,
  registry: IModuleRegistry,
): PageInvariantBundles {
  return {
    reset: makeBundleFile('reset', PUBLISHER_RESET_CSS),
    framework: makeBundleFile('framework', buildFrameworkCss(site, registry)),
  }
}

// Page-invariant bundle memo, keyed by publish version. A bump invalidates it
// (the next read sees a new version → recompute), so a content change can never
// serve stale platform CSS. Registered with the shared test-reset hook.
//
// Deliberately NOT keyed on the site object: every consumer loads the snapshot
// fresh (DB JSON parse per query), so an identity key would never hit — that
// was exactly the bug that made every Layer B miss re-walk the whole site.
let pageInvariantCache: { version: number; bundles: PageInvariantBundles } | null = null
registerVersionedCacheReset(() => {
  pageInvariantCache = null
})

/**
 * Return the page-invariant bundles for `version`, computing them once and
 * reusing the cached files on later renders of the same publish version.
 */
function memoizedPageInvariantBundles(
  site: SiteDocument,
  registry: IModuleRegistry,
  version: number,
): PageInvariantBundles {
  if (pageInvariantCache && pageInvariantCache.version === version) {
    return pageInvariantCache.bundles
  }
  const bundles = computePageInvariantBundles(site, registry)
  pageInvariantCache = { version, bundles }
  return bundles
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
