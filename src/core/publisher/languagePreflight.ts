import type { SiteDocument } from '@core/page-tree'
import { resolveSiteLanguage, resolveTranslation } from '@core/localization'
import { parseTokenString } from '@core/templates'

/**
 * Validate authored language bindings before any publication state is written.
 * All configured catalogues have identical keys; checking each authored key
 * against one catalogue proves coverage for every page without rendering HTML.
 * The ordinary token parser owns escaping and binding syntax here as well.
 */
export function assertSiteTranslations(site: SiteDocument): void {
  const frame = resolveSiteLanguage(site)
  for (const page of site.pages) resolveSiteLanguage(site, page.language)

  const keys = new Set<string>()
  const collectText = (value: unknown) => {
    if (typeof value !== 'string' || !value.includes('{')) return
    for (const segment of parseTokenString(value)) {
      if (segment.kind === 'token' && segment.source === 'site' && segment.field.startsWith('translations.')) {
        keys.add(segment.field.slice('translations.'.length))
      }
    }
  }
  const collectProps = (props: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(props)) {
      collectText(value)
      // Native attributes and VC instance params are the authored string bags
      // that the renderer consumes beyond a node's flat property values.
      if ((name === 'htmlAttributes' || name === 'propOverrides') && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const nestedValue of Object.values(value)) collectText(nestedValue)
      }
    }
  }
  const collectJsonStrings = (value: unknown): void => {
    if (typeof value === 'string') collectText(value)
    else if (Array.isArray(value)) for (const item of value) collectJsonStrings(item)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collectJsonStrings(item)
  }

  collectText(site.settings.metaTitle)
  collectText(site.settings.metaDescription)
  for (const page of site.pages) {
    collectText(page.seo?.title)
    collectText(page.seo?.description)
    collectText(page.seo?.canonical)
    for (const alternate of page.seo?.alternates ?? []) collectText(alternate.href)
    for (const meta of page.seo?.meta ?? []) {
      collectText(meta.content)
      collectText(meta.media)
    }
    for (const link of page.seo?.links ?? []) {
      for (const field of ['href', 'type', 'sizes', 'media'] as const) collectText(link[field])
    }
    collectJsonStrings(page.seo?.structuredData)
    for (const node of Object.values(page.nodes)) {
      collectProps(node.props)
      for (const binding of Object.values(node.dynamicBindings ?? {})) {
        if (binding.source === 'site' && binding.field.startsWith('translations.')) {
          keys.add(binding.field.slice('translations.'.length))
        }
      }
    }
  }
  for (const component of site.visualComponents) {
    for (const node of Object.values(component.tree.nodes)) collectProps(node.props)
    for (const param of component.params) collectText(param.defaultValue)
  }
  for (const key of keys) resolveTranslation(frame.translations, key, frame.language)
}
