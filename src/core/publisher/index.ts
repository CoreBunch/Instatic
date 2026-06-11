// Public API for the publisher engine.
//
// The publisher turns page trees into clean, static HTML + CSS at publish time
// (and renders dynamic fragments / previews at request time). External consumers
// import from `@core/publisher`; files inside this module import each other via
// relative paths and never through this barrel.

export { publishPage } from './render'
export type { PublishedRuntimePackageImportmap } from './render'

export { renderNode, resolveSpecialRenderer, getSpecialRendererModuleIds } from './renderNode'

export { collectHoleSubtreeModuleIds } from './holeSubtreeModules'

export type {
  RenderConfig,
  RenderAccumulators,
  RenderResolvedMedia,
  ResolvedLoopRenderData,
} from './renderConfig'

export { escapeProps } from './escapeProps'

export {
  addCspSources,
  createBaseCspPlan,
  cspMetaTag,
  emptyCspPlan,
  parseCspContent,
  rewriteCspMeta,
  serializeCsp,
  setCspDirective,
} from './cspPlan'
export type { CspPlan } from './cspPlan'

export { escapeHtml, isSafeUrl, safeUrl, sanitiseCssValue } from './utils'

export {
  bagToCSS,
  createStyleRuleCssEmitter,
  generateClassCSS,
  isEmittableProperty,
} from './classCss'
export type { StyleRuleCssEmitter, ViewportContext } from './classCss'

export { collectClassCSS, CssCollector, sanitizeModuleCSS } from './cssCollector'

export { buildSiteFrameworkCss, generateFrameworkCss } from './frameworkCss'

export { collectUserStylesheetCss } from './userStylesheets'

export { PUBLISHER_RESET_CSS } from './reset'

export { resolveAutoSizes } from './sizesResolver'

export type { CssBundleFile, SiteCssBundle, SiteCssBundleId } from './siteCssBundle'
