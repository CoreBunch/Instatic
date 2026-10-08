import type { PageNode, SiteDocument } from '@core/page-tree'
import { walkRenderTree } from '@core/visualComponents'
import { assertPageTranslationGroups, composeTemplateChain, parseTokenString, readPageTranslationField, resolvePageTranslations, resolveTemplateChain } from '@core/templates'

/** Check effective static pages and reachable components before snapshot writes. */
export function assertPageTranslationBindings(site: SiteDocument): void {
  assertPageTranslationGroups(site)
  const chain = resolveTemplateChain(site, { kind: 'page' })
  for (const page of site.pages) {
    if (page.template?.enabled) continue
    const translations = resolvePageTranslations(page, site)
    const checkText = (value: unknown) => {
      if (typeof value !== 'string' || !value.includes('{')) return
      for (const token of parseTokenString(value)) {
        if (token.kind === 'token' && token.source === 'page' && token.field.startsWith('translations.')) {
          readPageTranslationField(translations, token.field.slice('translations.'.length))
        }
      }
    }
    const checkJson = (value: unknown): void => {
      if (typeof value === 'string') checkText(value)
      else if (Array.isArray(value)) for (const item of value) checkJson(item)
      else if (value && typeof value === 'object') for (const item of Object.values(value)) checkJson(item)
    }
    const checkNode = (node: PageNode) => {
      for (const [name, value] of Object.entries(node.props)) {
        checkText(value)
        if (name === 'htmlAttributes' && value && typeof value === 'object' && !Array.isArray(value)) {
          for (const nested of Object.values(value)) checkText(nested)
        }
      }
      for (const binding of Object.values(node.dynamicBindings ?? {})) {
        if (binding.source === 'page' && binding.field.startsWith('translations.')) {
          readPageTranslationField(translations, binding.field.slice('translations.'.length))
        }
      }
    }
    checkText(site.settings.metaTitle)
    checkText(site.settings.metaDescription)
    checkJson(page.seo)
    const effective = composeTemplateChain(chain, { kind: 'page', page })
    walkRenderTree(effective.nodes, effective.rootNodeId, site.visualComponents, checkNode)
  }
}
