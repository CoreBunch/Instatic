import type { Page, SiteDocument } from '@core/page-tree'
import { composeTemplateChain } from './templateCompose'
import { isTemplatePage, resolveNotFoundTemplate, resolveTemplateChain } from './templateMatching'

export type PublishedRenderScope =
  | { kind: 'page' | 'notFound'; sourcePage: Page; page: Page }
  | { kind: 'entry'; tableSlug: string; page: Page }

/** Native trees that public routing can emit; raw unused templates are never scopes. */
export function* publishedRenderScopes(site: SiteDocument): Generator<PublishedRenderScope> {
  const pageChain = resolveTemplateChain(site, { kind: 'page' })
  for (const sourcePage of site.pages) {
    if (!isTemplatePage(sourcePage)) {
      yield { kind: 'page', sourcePage, page: composeTemplateChain(pageChain, { kind: 'page', page: sourcePage }) }
    }
  }
  const notFound = resolveNotFoundTemplate(site)
  if (notFound) yield { kind: 'notFound', sourcePage: notFound, page: composeTemplateChain(pageChain, { kind: 'page', page: notFound }) }

  const tableSlugs = new Set<string>()
  for (const page of site.pages) {
    if (isTemplatePage(page) && page.template?.target.kind === 'postTypes') {
      for (const tableSlug of page.template.target.tableSlugs) tableSlugs.add(tableSlug)
    }
  }
  for (const tableSlug of tableSlugs) {
    const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug })
    if (chain.length > 0) yield { kind: 'entry', tableSlug, page: composeTemplateChain(chain, { kind: 'entry' }) }
  }
}
