import type { Page, SiteDocument } from '@core/page-tree'
import { buildPublicFileReferences, readPublicFileField } from '@core/files/references'
import {
  buildTemplateRenderContext, effectiveNodeBindings,
  parseTokenString, publishedRenderScopes, resolveDynamicProps,
  type TemplateRenderDataContext,
} from '@core/templates'
import { walkRenderTree } from '@core/visualComponents'
import type { DocumentMetaOverride } from './documentMeta'

/** Validate actual native bindings without rendering modules or mutating publication. */
export function assertPagePublicFileBindings(
  page: Page,
  site: SiteDocument,
  incoming?: TemplateRenderDataContext,
  documentMeta: DocumentMetaOverride = {},
): void {
  const context = buildTemplateRenderContext(page, site, incoming)
  const inspect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.includes('{')) return
      for (const segment of parseTokenString(value)) {
        if (segment.kind === 'token' && segment.source === 'file') readPublicFileField(context.files, segment.field)
      }
    } else if (Array.isArray(value)) for (const item of value) inspect(item)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) inspect(item)
  }
  walkRenderTree(page.nodes, page.rootNodeId, site.visualComponents, (node) => {
    // Reference params and raw slot children are not emitted properties. The
    // visitor checks their effective values in the materialized component.
    if (node.moduleId !== 'base.visual-component-ref') {
      resolveDynamicProps(node.props, effectiveNodeBindings(node), context)
    }
  })
  const seo = page.seo
  inspect(documentMeta.title || seo?.title || site.settings.metaTitle || page.title || site.name)
  inspect(documentMeta.description || seo?.description || site.settings.metaDescription)
  inspect(seo?.canonical)
  for (const alternate of seo?.alternates ?? []) inspect(alternate.href)
  for (const meta of seo?.meta ?? []) { inspect(meta.content); inspect(meta.media) }
  for (const link of seo?.links ?? []) {
    for (const key of ['href', 'type', 'sizes', 'media'] as const) inspect(link[key])
  }
  inspect(seo?.structuredData)
  if (!seo?.links?.some((link) => link.rel === 'icon')) inspect(site.settings.faviconUrl)
}

/** Compose the same page, entry and 404 trees used by the ordinary publisher. */
export function assertSitePublicFileBindings(site: SiteDocument): void {
  const files = buildPublicFileReferences(site.files)
  for (const scope of publishedRenderScopes(site)) {
    const context = scope.kind === 'entry' ? { entryStack: [], files }
      : buildTemplateRenderContext(scope.sourcePage, site, { entryStack: [], files })
    assertPagePublicFileBindings(scope.page, site, context)
  }
}
