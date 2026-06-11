import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { publishPage } from '@core/publisher'
import type { PublishedRuntimePackageImportmap } from '@core/publisher'
import { prefetchLoopData } from '../loopPrefetch'
import { prefetchMediaAssets } from '../mediaPrefetch'
import { collectFrontendInjections, injectFrontendAssets } from '../frontendInjections'
import type { DbClient } from '../../db/client'
import {
  buildSiteRuntimeScripts,
  type BuiltRuntimeAssetFile,
  type BuildSiteRuntimeScriptsInput,
  type SiteRuntimeBuildResult,
} from './bundleScripts'
import {
  buildRuntimePackageImportmap,
  serializeImportmapForCsp,
} from './packageImportmap'

interface RuntimePreviewDocumentInput {
  site: SiteDocument
  page: Page
  registry: IModuleRegistry
  assetBasePath: string
  // The previewer needs `hash` in addition to `nodeModulesDir` so it can
  // emit a `<script type="importmap">` whose URLs embed the lock hash —
  // those URLs are served by `tryServeRuntimePackage`. The script bundler
  // only needs `nodeModulesDir`, so we widen the type at this boundary.
  dependencyCache?: BuildSiteRuntimeScriptsInput['dependencyCache'] & { hash?: string }
  dependencyNodeModulesDir?: string
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
  /**
   * Optional DB client — when supplied, every `base.loop` node on the
   * page is pre-fetched against the database, so loops render with real
   * data in the editor's runtime preview (iframe canvas). Without it,
   * loops emit a "no resolved data" comment.
   */
  db?: DbClient
}

interface RuntimePreviewDocumentResult extends SiteRuntimeBuildResult {
  html: string
  files: BuiltRuntimeAssetFile[]
}

export async function buildRuntimePreviewDocument(
  input: RuntimePreviewDocumentInput,
): Promise<RuntimePreviewDocumentResult> {
  const runtimeBuild = await buildSiteRuntimeScripts({
    site: input.site,
    page: input.page,
    target: 'canvas',
    assetBasePath: input.assetBasePath,
    dependencyCache: input.dependencyCache,
    dependencyNodeModulesDir: input.dependencyNodeModulesDir,
  })
  // Build the package importmap from the already-populated dependency cache.
  // The cache here is the same handle the caller produced by
  // `ensureRuntimeDependencyCache(lock)` before calling us, so by the time we
  // reach this point `node_modules/` is on disk and ready to be enumerated.
  let runtimePackageImportmap: PublishedRuntimePackageImportmap | undefined
  if (input.dependencyCache?.hash && input.dependencyCache.nodeModulesDir) {
    const runtime = normalizeSiteRuntimeConfig(input.site.runtime)
    const built = await buildRuntimePackageImportmap(
      runtime.dependencyLock,
      {
        hash: input.dependencyCache.hash,
        nodeModulesDir: input.dependencyCache.nodeModulesDir,
      },
    )
    if (built) {
      const serialized = await serializeImportmapForCsp(built.importmap)
      runtimePackageImportmap = { body: serialized.body, sha256: serialized.sha256 }
    }
  }
  const [loopData, mediaAssets] = input.db
    ? await Promise.all([
        prefetchLoopData(input.page, input.site, input.db),
        prefetchMediaAssets(input.page, input.site, input.registry, input.db),
      ])
    : [undefined, undefined]
  const baseHtml = publishPage(input.page, input.site, input.registry, {
    breakpointId: input.breakpointId,
    templateContext: input.templateContext,
    runtimeAssets: runtimeBuild.runtimeAssets,
    runtimePackageImportmap,
    loopData,
    mediaAssets,
  }).html

  // Mirror the published-page path: pull each enabled plugin's
  // `frontend.assets[]` into the document and relax the CSP the same way
  // the public renderer + dispatcher pipeline does. Without this, the
  // iframe preview would block plugin scripts (their `<script>` tags
  // wouldn't be emitted at all) and any `networkAllowedHosts` declared
  // by plugins wouldn't reach `connect-src` — visitor-side `fetch()` to
  // external hosts would fail under `default-src 'self'` even though the
  // published page would allow them.
  //
  // The preview iframe does NOT fire `publish.before / publish.html /
  // publish.after` — those mutate persisted state and aren't safe to run
  // on every keystroke. Plugins that need to rewrite the HTML in the
  // preview can hook frontend injection (which IS shared) and emit the
  // same CSP envelope; full HTML filtering is reserved for the real
  // publish path.
  const html = input.db
    ? injectFrontendAssets(baseHtml, await collectFrontendInjections(input.db))
    : baseHtml

  return {
    ...runtimeBuild,
    html,
  }
}
