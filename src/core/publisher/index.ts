// Public API for the publisher engine.
//
// The publisher turns page trees into clean, static HTML + CSS at publish time
// (and renders dynamic fragments / previews at request time). External consumers
// import from `@core/publisher`; files inside this module import each other via
// relative paths and never through this barrel.

export { publishPage } from './render'
export { assertPagePublicFileBindings, assertSitePublicFileBindings } from './publicFilePreflight'
export { assertSiteTranslations } from './languagePreflight'
export { collectLoopRenderScopes, assertLoopRenderScopes, assertPageLoopScopes, assertSiteLoopScopes, LoopScopeConfigurationError } from './loopRenderScopes'
export type { LoopRenderScope } from './loopRenderScopes'
export { findDynamicNodeIds } from './dynamicDetection'
export type { PublishedRuntimePackageImportmap } from './render'
export type { DocumentMetaOverride } from './documentMeta'

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

export { htmlAttributesAttr } from './htmlAttributesEmit'

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
export type { ClassCssOptions } from './cssCollector'
export { collectPageStyleRuleIds } from './pageStyleUsage'
export type { StyleRuleScriptSource } from './pageStyleUsage'
export {
  collectUsedStyleRuleIds,
  treeShakeStyleRules,
  treeShakeStyleRulesBySignature,
} from './styleRuleTreeShake'

export { buildSiteFrameworkCss, generateFrameworkCss } from './frameworkCss'

export { collectUserStylesheetCss } from './userStylesheets'

export { PUBLISHER_RESET_CSS } from './reset'

export { resolveAutoSizes } from './sizesResolver'

export type { CssBundleFile, SiteCssBundle, SiteCssBundleId } from './siteCssBundle'

export { collectModuleAssets } from './moduleAssets'
export type { ModuleAssetMaps } from './moduleAssets'
