import type { PageNode, SiteDocument } from '@core/page-tree'
import { resolveSiteLanguage, resolveTranslation } from '@core/localization'
import { composeTemplateChain, parseTokenString, resolveTemplateChain } from '@core/templates'
import { walkRenderTree } from '@core/visualComponents'
import { assertPageTranslationBindings } from './pageTranslationPreflight'

/** Validate each effective render's translations before snapshot writes. */
export function assertSiteTranslations(site: SiteDocument): void {
  assertPageTranslationBindings(site)
  resolveSiteLanguage(site)
  const chain = resolveTemplateChain(site, { kind: 'page' })
  for (const page of site.pages) {
    // Dynamic templates can render entries in any configured language.
    const languages = page.template?.enabled && site.settings.localization
      ? site.settings.localization.catalogues.map((catalogue) => catalogue.language)
      : [page.language]
    const effective = page.template?.enabled ? page : composeTemplateChain(chain, { kind: 'page', page })
    for (const language of languages) {
      const frame = resolveSiteLanguage(site, language)
      const checkKey = (key: string) => resolveTranslation(frame.translations, key, frame.language)
      const checkText = (value: unknown) => {
        if (typeof value !== 'string' || !value.includes('{')) return
        for (const token of parseTokenString(value)) {
          if (token.kind === 'token' && token.source === 'site' && token.field.startsWith('translations.')) {
            checkKey(token.field.slice('translations.'.length))
          }
        }
      }
      const checkJson = (value: unknown): void => {
        if (typeof value === 'string') checkText(value)
        else if (Array.isArray(value)) for (const item of value) checkJson(item)
        else if (value && typeof value === 'object') for (const item of Object.values(value)) checkJson(item)
      }
      const checkNode = (node: PageNode) => {
        checkJson(node.props)
        for (const binding of Object.values(node.dynamicBindings ?? {})) {
          if (binding.source === 'site' && binding.field.startsWith('translations.')) {
            checkKey(binding.field.slice('translations.'.length))
          }
        }
      }
      checkText(site.settings.metaTitle)
      checkText(site.settings.metaDescription)
      checkJson(page.seo)
      walkRenderTree(effective.nodes, effective.rootNodeId, site.visualComponents, checkNode)
    }
  }
}
