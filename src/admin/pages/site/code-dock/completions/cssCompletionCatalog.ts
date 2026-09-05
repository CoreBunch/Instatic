/**
 * What the CSS panel completes beyond CSS itself: the editable class names
 * for selectors, and — inside `var(…)` — every custom property that exists
 * on the published site (framework tokens plus author-declared properties;
 * never the admin UI's own tokens).
 */
import type { SiteDocument } from '@core/page-tree'
import { collectSiteCustomProperties } from '@core/cssProjection'
import type { CssCompletionCatalog } from '@site/code-editor/completionCatalog'
import { deriveClassCompletions } from './classCompletions'

export function deriveCssCompletionCatalog(site: SiteDocument): CssCompletionCatalog {
  return {
    kind: 'css',
    classes: deriveClassCompletions(site, { includeGenerated: false }),
    customProperties: collectSiteCustomProperties(site),
  }
}
