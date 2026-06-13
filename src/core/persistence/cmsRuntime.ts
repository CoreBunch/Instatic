import type {
  PublishedPageRuntimeAssets,
  RuntimePackageImportmap,
  SiteDependencyLock,
  SiteRuntimeDiagnostic,
} from '@core/site-runtime'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { apiRequest, type FetchLike } from '@core/http'
import {
  CmsRuntimeDependencyEnvelopeSchema,
  CmsRuntimePreviewResponseSchema,
  type CmsRuntimePreviewAsset,
} from './responseSchemas'

export interface CmsRuntimePreviewResult {
  html: string
  assets: CmsRuntimePreviewAsset[]
  runtimeAssets: PublishedPageRuntimeAssets
  diagnostics: SiteRuntimeDiagnostic[]
}

interface CmsRuntimePreviewInput {
  site: unknown
  pageId: string
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
}

interface CmsRuntimeDependencyResolveResult {
  dependencyLock: SiteDependencyLock
  /**
   * Precomputed importmap from the server's `bun install` cache. Absent
   * when the lock has no resolvable packages or the install step skipped.
   * Callers that get an importmap should persist it on
   * `site.runtime.packageImportmap` so the editor iframe sandbox and the
   * published page consume the same URLs.
   */
  packageImportmap?: RuntimePackageImportmap
}

export async function resolveCmsRuntimeDependencies(
  packageJson: SitePackageJson,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRuntimeDependencyResolveResult> {
  // The envelope schema validates SiteDependencyLock + RuntimePackageImportmap
  // in full (both own canonical schemas in @core/site-runtime), so the parsed
  // body is already correctly typed — no cast needed.
  const body = await apiRequest(`${basePath}/runtime/dependencies/resolve`, {
    method: 'POST',
    body: { packageJson },
    schema: CmsRuntimeDependencyEnvelopeSchema,
    fetchImpl,
    fallbackMessage: 'Runtime dependency resolution failed',
  })
  return {
    dependencyLock: body.dependencyLock,
    ...(body.packageImportmap ? { packageImportmap: body.packageImportmap } : {}),
  }
}

export async function buildCmsRuntimePreview(
  input: CmsRuntimePreviewInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRuntimePreviewResult> {
  // The envelope schema validates the assets, runtimeAssets, and diagnostics
  // shapes in full against the canonical @core/site-runtime schemas, so the
  // parsed body matches CmsRuntimePreviewResult directly — no cast needed.
  const body = await apiRequest(`${basePath}/runtime/preview`, {
    method: 'POST',
    body: input,
    schema: CmsRuntimePreviewResponseSchema,
    fetchImpl,
    fallbackMessage: 'Runtime preview build failed',
  })
  return {
    html: body.html,
    assets: body.assets,
    runtimeAssets: body.runtimeAssets,
    diagnostics: body.diagnostics,
  }
}
