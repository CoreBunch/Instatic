/**
 * Public barrel for site fragments — the portable "piece of a site" format and
 * the engine that extracts and inserts it — and for site themes, a site's
 * design variables without its content, applied on the same machinery.
 *
 * Everything here is headless: no React, no admin, no server. A build script
 * can import this barrel by path under Bun (`src/core/fragments`), extract
 * fragments from a site-transfer archive and plan inserts against a site
 * document without loading the editor.
 */

export {
  SITE_FRAGMENT_FORMAT,
  SITE_FRAGMENT_VERSION,
  SiteFragmentSchema,
  FragmentParseError,
  parseSiteFragment,
} from './schema'
export type {
  FragmentKind,
  FragmentLink,
  FragmentMedia,
  FragmentOutsideDependency,
  FragmentScaleStep,
  FragmentTable,
  FragmentTableRow,
  FragmentTokens,
  SiteFragment,
} from './schema'

export type { FragmentWarning, FragmentWarningCode } from './warnings'

export {
  FragmentSourceError,
  fragmentSourceFromBundle,
  fragmentSourceFromBundleArchive,
  fragmentSourceFromSite,
} from './source'
export type { FragmentSource, FragmentSourceMedia } from './source'

export { FragmentExtractError, extractFragment } from './extract'
export type { ExtractFragmentOptions, ExtractFragmentResult, FragmentSelection } from './extract'

export {
  FRAGMENT_PACKAGE_MANIFEST,
  THEME_PACKAGE_MANIFEST,
  readFragmentPackage,
  readThemePackage,
  writeFragmentPackage,
  writeThemePackage,
} from './package'
export type { FragmentPackage, ThemePackage } from './package'

export { mediaPackagePath, sha256Hex } from './mediaKeys'

export { FragmentInsertError, planFragmentInsert } from './plan'
export type { FragmentInsertErrorCode } from './plan'
export { FRAGMENT_PROPERTIES_ORIGIN } from './planTokens'
export type {
  FragmentInsertDocument,
  FragmentInsertPlacement,
  FragmentInsertPlan,
  FragmentInsertReport,
  FragmentInsertTarget,
  FragmentPlanOptions,
  PlannedCustomProperties,
  PlannedFontFamily,
  PlannedScaleSteps,
  PlannedTable,
  PlannedTableCreate,
  PlannedTableReuse,
} from './planTypes'

export type { ImportedFragmentAssets } from './deferredAssets'
export { placeFragmentLayout, loadFragmentAssets, finishFragmentAssets } from './deferredAssets'
export { resolveFragmentPlan } from './resolve'
export type { FragmentApplyResult, FragmentResolution, ResolvedFragmentPlan } from './resolve'
export { applyResolvedFragment } from './apply'
export type { FragmentPlacement } from './apply'
export type { FragmentAssetAdapter, FragmentInsertAdapter, FragmentMediaRef, ThemeApplyAdapter } from './adapter'
export { FragmentCommitError, commitFragmentPlan } from './commit'
export type { CommitFragmentPlanOptions, FragmentCommitErrorStage, FragmentInsertResult } from './commit'

// ── Themes ───────────────────────────────────────────────────────────────────
export { SITE_THEME_FORMAT, SITE_THEME_VERSION, SiteThemeSchema, parseSiteTheme } from './themeSchema'
export type { SiteTheme } from './themeSchema'
export { extractTheme } from './extractTheme'
export type { ExtractThemeOptions, ExtractThemeResult } from './extractTheme'
export { planThemeApply } from './planTheme'
export type {
  PlannedThemeFontToken,
  PlannedThemeScaleGroup,
  ThemeApplyPlan,
  ThemeApplyReport,
  ThemeApplyTarget,
  ThemeColorValues,
  ThemeScaleSizing,
} from './planTheme'
export { applyResolvedTheme, resolveThemePlan } from './applyTheme'
export type { ResolvedThemePlan, ThemeResolution } from './applyTheme'
export { commitThemePlan } from './commitTheme'
export type { ThemeApplyResult } from './commitTheme'
