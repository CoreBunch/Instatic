/**
 * Editor-side runtime endpoints — dependency resolution and live preview.
 *
 *   POST /admin/api/cms/runtime/dependencies/resolve — resolve a
 *        `package.json`-shaped payload into a `dependencyLock` object
 *        (gated by `runtime.dependencies`). Used when the editor wants to
 *        re-pin a site's npm dependencies.
 *
 *   POST /admin/api/cms/runtime/preview — build a single-page preview
 *        document (HTML + assets + diagnostics) for a given draft site
 *        (gated by `site.read`). Used by the visual builder's preview
 *        iframe. Read-floor capability is correct here: anyone who can
 *        open the site editor can preview the draft they posted.
 *
 * Both endpoints accept the draft site in the request body rather than
 * loading the persisted draft — preview must reflect unsaved edits.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { resolveSiteDependencyLock } from '../../publish/runtime/dependencyResolver'
import { ensureRuntimeDependencyCache } from '../../publish/runtime/dependencyCache'
import { buildRuntimePackageImportmap } from '../../publish/runtime/packageImportmap'
import { buildRuntimePreviewDocument } from '../../publish/runtime/previewRuntime'
import { validateSite, validatePages, validateVisualComponents, SiteValidationError } from '@core/persistence/validate'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { registry } from '@core/module-engine'
import {
  parseVisualComponent,
  flattenVCToVirtualPage,
  parseVirtualVCPageId,
} from '@core/visualComponents'
import type { Page, SiteDocument, SiteShell } from '@core/page-tree'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { getErrorMessage } from '@core/utils/errorMessage'

function runtimeDependencyMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const dependencies: Record<string, string> = {}
  for (const [rawName, rawVersion] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim()
    const version = typeof rawVersion === 'string' ? rawVersion.trim() : ''
    if (!name || !version || !isSafePackageName(name)) continue
    dependencies[name] = version
  }
  return dependencies
}

/**
 * Resolve the page to render in the runtime preview.
 *
 * The pageId comes from the editor's canvas selector, which can be either a
 * real page (`site.pages`) or a synthetic virtual page for a Visual Component
 * being edited in VC canvas mode. The latter are encoded with the
 * `vc-virtual:<vcId>` prefix and synthesized on demand from
 * `site.visualComponents` so the publisher can render the VC tree through the
 * normal page pipeline.
 */
function resolvePreviewPage(site: SiteDocument, pageId: string): Page | null {
  const realPage = site.pages.find((candidate) => candidate.id === pageId)
  if (realPage) return realPage

  const vcId = parseVirtualVCPageId(pageId)
  if (vcId === null) return null

  const vc = site.visualComponents.find((candidate) => candidate.id === vcId)
  if (!vc) return null

  return flattenVCToVirtualPage(vc)
}

function runtimeRequestPackageJson(raw: unknown): SitePackageJson {
  const manifest = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    dependencies: runtimeDependencyMap(manifest.dependencies),
    devDependencies: runtimeDependencyMap(manifest.devDependencies),
  }
}

export async function handleRuntimeRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === '/admin/api/cms/runtime/dependencies/resolve') {
    const user = await requireCapability(req, db, 'runtime.dependencies')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()

    const RuntimeDependencyBodySchema = Type.Object({ packageJson: Type.Unknown() })
    const body = await readValidatedBody(req, RuntimeDependencyBodySchema)
    if (!body) return badRequest('Invalid request body')
    try {
      const packageJson = runtimeRequestPackageJson(body.packageJson)
      const dependencyLock = await resolveSiteDependencyLock(packageJson)
      // Run the install + importmap build inline so the editor's iframe
      // sandbox has a usable map as soon as the user clicks "Resolve".
      // The cache is content-addressed by lock hash, so repeated resolves
      // of the same lock fast-path on the sentinel-file check inside
      // `ensureRuntimeDependencyCache` — no real-world cost.
      let packageImportmap: Awaited<ReturnType<typeof buildRuntimePackageImportmap>> = null
      if (Object.keys(dependencyLock.packages).length > 0) {
        try {
          const cache = await ensureRuntimeDependencyCache(dependencyLock)
          packageImportmap = await buildRuntimePackageImportmap(dependencyLock, cache)
        } catch (err) {
          // Lock resolution succeeded but install / importmap build did
          // not. Surface a warning in the log; the editor still gets the
          // lock so the dep list updates, but iframe previews will defer
          // until the user retries. Failing the whole request here would
          // block the dependency-panel UI on a recoverable error.
          console.warn('[runtime/dependencies/resolve] importmap build skipped:', err)
        }
      }
      return jsonResponse({
        dependencyLock,
        ...(packageImportmap
          ? {
              packageImportmap: {
                imports: packageImportmap.importmap.imports,
                lockHash: packageImportmap.lockHash,
              },
            }
          : {}),
      })
    } catch (err) {
      return badRequest(getErrorMessage(err, 'Runtime dependency resolution failed'))
    }
  }

  if (url.pathname === '/admin/api/cms/runtime/preview') {
    // Preview is a render — the right gate is the read floor for the site
    // editor, not page-metadata edit. A Designer holding `site.style.edit`
    // (and therefore `site.read`) needs to use the preview iframe even
    // though they don't have `pages.edit`. See A4 in the capabilities
    // review.
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user
    if (req.method !== 'POST') return methodNotAllowed()

    const RuntimePreviewBodySchema = Type.Object({
      pageId: Type.String(),
      breakpointId: Type.Optional(Type.String()),
      // templateContext is a complex TemplateRenderDataContext — unknown here, cast below
      templateContext: Type.Optional(Type.Unknown()),
      site: Type.Record(Type.String(), Type.Unknown()),
    })
    const body = await readValidatedBody(req, RuntimePreviewBodySchema)
    if (!body) return badRequest('Invalid request body')
    const pageId = body.pageId.trim()
    const breakpointId = body.breakpointId?.trim() || undefined
    // TemplateRenderDataContext has deep-nested types that can't be modelled in
    // TypeBox without mirroring the full interface — pass through as-is.
    const templateContext = body.templateContext as TemplateRenderDataContext | undefined
    if (!pageId) return badRequest('Missing pageId')

    try {
      const shell: SiteShell = validateSite(body.site)
      // The editor sends the full in-memory SiteDocument (shell + pages + VCs).
      // Parse each component separately so validateVisualComponents can run.
      const rawPages = Array.isArray(body.site.pages) ? body.site.pages : []
      const rawVCs = Array.isArray(body.site.visualComponents) ? body.site.visualComponents : []
      const parsedVCs = rawVCs.flatMap((raw) => {
        const vc = parseVisualComponent(raw)
        return vc ? [vc] : []
      })
      const visualComponents = validateVisualComponents(parsedVCs)
      // Strip page VC-refs only against ids present in the submitted roster, so
      // a deduped/de-cycled VC does not strip authored slot content from the
      // preview render (ISS-016).
      const pages = validatePages(shell, rawPages, visualComponents, {
        storedVcIds: new Set(parsedVCs.map((vc) => vc.id)),
      })
      // Saved layouts are editor-only; preview rendering ignores them.
      const site: SiteDocument = { ...shell, pages, visualComponents, layouts: [] }
      const page = resolvePreviewPage(site, pageId)
      if (!page) return jsonResponse({ error: 'Page not found' }, { status: 404 })

      const runtime = normalizeSiteRuntimeConfig(site.runtime)
      const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
        ? await ensureRuntimeDependencyCache(runtime.dependencyLock)
        : undefined
      const preview = await buildRuntimePreviewDocument({
        site,
        page,
        registry,
        assetBasePath: '/_instatic/preview/runtime/',
        dependencyCache,
        breakpointId,
        templateContext,
        db,
      })

      return jsonResponse({
        html: preview.html,
        assets: preview.files.map((file) => ({
          path: file.path,
          publicPath: file.publicPath,
          content: file.content,
          contentType: file.contentType,
        })),
        runtimeAssets: preview.runtimeAssets,
        diagnostics: preview.diagnostics,
      })
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      return badRequest(getErrorMessage(err, 'Runtime preview build failed'))
    }
  }

  return null
}
