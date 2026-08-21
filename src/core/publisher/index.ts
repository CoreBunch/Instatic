// Public API for the publisher engine.
//
// The publisher turns page trees into clean, static HTML + CSS at publish time
// (and renders dynamic fragments / previews at request time). External consumers
// import from `@core/publisher`; files inside this module import each other via
// relative paths and never through this barrel.

export { publishPage } from './render'
export type { DocumentMetaOverride, PublishedRuntimePackageImportmap } from './render'

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
  parseCspContent,
  rewriteCspMeta,
  serializeCsp,
  setCspDirective,
} from './cspPlan'


export { escapeHtml, isSafeUrl, safeUrl, sanitiseCssValue } from './utils'

export {
  bagToCSS,
  bagToInlineStyle,
  bagToReactStyle,
  createStyleRuleCssEmitter,
  generateClassCSS,
  isEmittableProperty,
} from './classCss'
export type {
  StyleRuleCssEmitter,
  StyleRuleDeclarationLayers,
  ViewportContext,
} from './classCss'

export {
  collectBackgroundImagePaths,
  collectBackgroundImagePathsFromStyleBag,
  collectNodeBackgroundImagePaths,
  collectSiteStyleBackgroundImagePaths,
  responsiveBackgroundImage,
} from './responsiveBackground'
export type { ResponsiveCssOptions } from './responsiveBackground'

export { collectClassCSS, CssCollector, sanitizeModuleCSS } from './cssCollector'
export {
  collectUsedStyleRuleIds,
  treeShakeStyleRules,
  treeShakeStyleRulesBySignature,
  usedStyleRuleIdSignature,
} from './styleRuleTreeShake'

export { buildSiteFrameworkCss, generateFrameworkCss } from './frameworkCss'

export { collectUserStylesheetCss } from './userStylesheets'

export { PUBLISHER_RESET_CSS } from './reset'

export { resolveAutoSizes } from './sizesResolver'

export type { CssBundleFile, SiteCssBundle, SiteCssBundleId } from './siteCssBundle'
