/**
 * Published module-JS channel — server-side builder + injector.
 *
 * `render()` may return `js` next to `html`/`css` (see `RenderOutput`). The
 * publisher dedupes it per moduleId into `RenderAccumulators.jsMap`; this file
 * owns the site-wide map and the page-level `<script>` injection:
 *
 * - `buildSiteModuleJsMap` rebuilds the map from scratch (preview, tests).
 * - `buildPublishedSiteModuleJsMap` memoises it by publishVersion + site
 *   object — the same pattern (and the same invalidation via
 *   `bumpPublishVersion()` / `registerVersionedCacheReset`) as
 *   `buildPublishedSiteCssBundle` in `siteCssBundle.ts`.
 * - `resolveModuleScripts` turns a page's candidate moduleIds into the
 *   scripts it loads: the ids that ship JS, each with the content hash of its
 *   body.
 * - `injectModuleScripts` is the post-render pipeline step: appends one
 *   `<script src="/_instatic/module-js/<id>.js?v=<contentHash>" defer>` tag
 *   per script before `</body>` and relaxes the page CSP `script-src` to
 *   `'self'` iff at least one tag was injected.
 *
 * `?v=` is the hash of the script body, never the publish counter: the
 * counter restarts at 0 on every boot, so a counter URL repeats one a browser
 * cached before a restart or an upgrade, with a different body behind it.
 *
 * The matching asset route lives in `server/handlers/cms/moduleJs.ts`.
 */
import type { SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import { addCspSources, escapeHtml, rewriteCspMeta } from '@core/publisher'
import { assetContentVersion } from './assetVersion'
import { collectSiteModuleAssets } from './siteModuleAssets'
import { getPublishVersion, registerVersionedCacheReset } from './publishState'

/** Build the moduleId → JS map fresh. Use for draft/preview/arbitrary sites. */
export function buildSiteModuleJsMap(
  site: SiteDocument,
  registry: IModuleRegistry,
): ReadonlyMap<string, string> {
  return collectSiteModuleAssets(site, registry).jsMap
}

// Memo keyed by publish version + site object, mirroring the page-invariant
// CSS bundle memo. A bump invalidates it; the shared test-reset hook clears it.
let moduleJsCache: {
  version: number
  site: SiteDocument
  map: ReadonlyMap<string, string>
} | null = null
registerVersionedCacheReset(() => {
  moduleJsCache = null
})

/**
 * Published-render variant: memoised per publishVersion + site object so the
 * O(all-pages) walk runs once per published snapshot, not once per render.
 * Safe ONLY for the published-snapshot render path (same caveat as
 * `buildPublishedSiteCssBundle`).
 */
export function buildPublishedSiteModuleJsMap(
  site: SiteDocument,
  registry: IModuleRegistry,
): ReadonlyMap<string, string> {
  const version = getPublishVersion()
  if (moduleJsCache && moduleJsCache.version === version && moduleJsCache.site === site) {
    return moduleJsCache.map
  }
  const map = buildSiteModuleJsMap(site, registry)
  moduleJsCache = { version, site, map }
  return map
}

/** One published module script a page loads. */
export interface ModuleScriptRef {
  moduleId: string
  /** Content hash of the script body, stamped as `?v=` on the tag. */
  version: string
}

// Maps are immutable once built and shared by every render of a snapshot, so
// each body is hashed once per map, not once per rendered page.
const moduleJsVersions = new WeakMap<ReadonlyMap<string, string>, Map<string, string>>()

/** Content hash of one module's body in `moduleJsMap`; undefined when the module ships no JS. */
export function moduleJsVersion(
  moduleJsMap: ReadonlyMap<string, string>,
  moduleId: string,
): string | undefined {
  const body = moduleJsMap.get(moduleId)
  if (body === undefined) return undefined
  let versions = moduleJsVersions.get(moduleJsMap)
  if (!versions) {
    versions = new Map()
    moduleJsVersions.set(moduleJsMap, versions)
  }
  let version = versions.get(moduleId)
  if (version === undefined) {
    version = assetContentVersion(body)
    versions.set(moduleId, version)
  }
  return version
}

/**
 * The scripts a page loads: its candidate moduleIds (render-emitted plus hole
 * subtrees, over-inclusive) narrowed to the modules that ship JS in
 * `moduleJsMap`, each with its body's content hash. Sorted and de-duplicated
 * for deterministic output; every returned script resolves on the asset route.
 */
export function resolveModuleScripts(
  candidateModuleIds: readonly string[],
  moduleJsMap: ReadonlyMap<string, string>,
): ModuleScriptRef[] {
  const scripts: ModuleScriptRef[] = []
  for (const moduleId of [...new Set(candidateModuleIds)].sort()) {
    const version = moduleJsVersion(moduleJsMap, moduleId)
    if (version !== undefined) scripts.push({ moduleId, version })
  }
  return scripts
}

/**
 * Append the page's module-JS `<script>` tags before `</body>` and relax the
 * CSP `script-src` to `'self'` iff at least one tag was injected.
 *
 * `scripts` comes from `resolveModuleScripts`, so every emitted URL resolves
 * and carries the hash of the body it loads. Idempotent under repeated
 * pipeline passes.
 */
export function injectModuleScripts(html: string, scripts: readonly ModuleScriptRef[]): string {
  if (scripts.length === 0 || html.includes('data-instatic-module-js=')) return html
  const tags = scripts
    .map(
      ({ moduleId, version }) =>
        `<script src="/_instatic/module-js/${encodeURIComponent(moduleId)}.js?v=${version}" defer data-instatic-module-js="${escapeHtml(moduleId)}"></script>`,
    )
    .join('\n')
  const withScripts = html.includes('</body>')
    ? html.replace('</body>', `${tags}\n</body>`)
    : `${html}\n${tags}`
  // External same-origin scripts only need `script-src 'self'` — merged as
  // data so ordering stays deterministic next to plugin/media relaxations.
  return rewriteCspMeta(withScripts, (csp) => addCspSources(csp, 'script-src', ["'self'"]))
}
