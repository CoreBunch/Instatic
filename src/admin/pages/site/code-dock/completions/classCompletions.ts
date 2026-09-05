/**
 * The site's class names as completion entries, with site-wide usage
 * counts — the same registry and usage map the class picker reads.
 */
import { isGeneratedClass, isUserVisibleClass, type SiteDocument } from '@core/page-tree'
import { buildSelectorUsageMap } from '@site/panels/selectorUsage'
import type { ClassNameCompletion } from '@site/code-editor/completionCatalog'

export function deriveClassCompletions(
  site: SiteDocument,
  options: { includeGenerated: boolean },
): ClassNameCompletion[] {
  const usage = buildSelectorUsageMap(site)
  return Object.values(site.styleRules)
    .filter((rule) => rule.kind === 'class' && isUserVisibleClass(rule))
    .filter((rule) => options.includeGenerated || !isGeneratedClass(rule))
    .sort((a, b) => a.order - b.order)
    .map((rule) => ({ name: rule.name, usage: usage.get(rule.id) ?? 0, generated: isGeneratedClass(rule) }))
}
