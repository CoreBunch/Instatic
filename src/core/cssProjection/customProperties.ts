/**
 * The CSS custom properties that exist on the PUBLISHED site — what a
 * `var(…)` in an author stylesheet can legitimately reference:
 *
 *   1. every framework-generated token variable (`describeFrameworkTokens`,
 *      so the list can never name a variable the `:root` block doesn't emit);
 *   2. every property an author declared in a style rule (base styles and
 *      every context override), in cascade order;
 *   3. every property declared in a style code asset (`type: 'style'` file).
 *
 * The admin UI's own tokens (`--editor-*`, `--space-*` from globals.css …)
 * are deliberately NOT a source: they exist in the editor document only.
 * One entry per name; the first declaration in the order above wins.
 */
import type { SiteDocument } from '@core/page-tree'
import { describeFrameworkTokens } from '@core/framework'

export interface SiteCustomProperty {
  /** Including the leading dashes, e.g. `--primary`. */
  name: string
  /** The declared (framework: light / min-breakpoint resolved) value. */
  value: string | null
  origin: 'framework' | 'rule' | 'asset'
  /** Where the property is declared: framework family, rule selector, or file path. */
  declaredIn: string
}

type CustomPropertySite = Pick<SiteDocument, 'settings' | 'styleRules' | 'files'>

const CUSTOM_PROPERTY_DECLARATION = /(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g

function isCustomPropertyName(name: string): boolean {
  return name.startsWith('--')
}

function frameworkProperties(site: CustomPropertySite): SiteCustomProperty[] {
  const digest = describeFrameworkTokens(site.settings.framework)
  const result: SiteCustomProperty[] = []
  for (const color of digest.colors) {
    result.push({ name: color.cssVar, value: color.value, origin: 'framework', declaredIn: 'Framework · colors' })
    for (const variant of color.variants) {
      result.push({ name: variant.cssVar, value: variant.value, origin: 'framework', declaredIn: 'Framework · colors' })
    }
  }
  for (const [family, groups] of [['typography', digest.typography], ['spacing', digest.spacing]] as const) {
    for (const group of groups) {
      for (const step of group.steps) {
        result.push({ name: step.cssVar, value: step.value, origin: 'framework', declaredIn: `Framework · ${family}` })
      }
    }
  }
  return result
}

function ruleProperties(site: CustomPropertySite): SiteCustomProperty[] {
  const result: SiteCustomProperty[] = []
  const rules = Object.values(site.styleRules).sort((a, b) => a.order - b.order)
  for (const rule of rules) {
    const bags = [rule.styles, ...Object.values(rule.contextStyles ?? {})]
    for (const bag of bags) {
      for (const [name, value] of Object.entries(bag)) {
        if (!isCustomPropertyName(name)) continue
        result.push({
          name,
          value: typeof value === 'string' || typeof value === 'number' ? String(value) : null,
          origin: 'rule',
          declaredIn: rule.selector,
        })
      }
    }
  }
  return result
}

function assetProperties(site: CustomPropertySite): SiteCustomProperty[] {
  const result: SiteCustomProperty[] = []
  for (const file of site.files) {
    if (file.type !== 'style' || typeof file.content !== 'string') continue
    const source = file.content.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const match of source.matchAll(CUSTOM_PROPERTY_DECLARATION)) {
      result.push({ name: match[1], value: match[2].trim() || null, origin: 'asset', declaredIn: file.path })
    }
  }
  return result
}

export function collectSiteCustomProperties(site: CustomPropertySite): SiteCustomProperty[] {
  const seen = new Set<string>()
  const result: SiteCustomProperty[] = []
  for (const property of [...frameworkProperties(site), ...ruleProperties(site), ...assetProperties(site)]) {
    if (seen.has(property.name)) continue
    seen.add(property.name)
    result.push(property)
  }
  return result
}
