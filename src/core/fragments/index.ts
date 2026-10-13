/**
 * Public barrel for site fragments — the portable "piece of a site" format and
 * the engine that extracts and inserts it.
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

export { FRAGMENT_PACKAGE_MANIFEST, readFragmentPackage, writeFragmentPackage } from './package'
export type { FragmentPackage } from './package'

export { mediaPackagePath, sha256Hex } from './mediaKeys'

export { FragmentInsertError, planFragmentInsert } from './plan'
export type { FragmentInsertErrorCode } from './plan'
export { FRAGMENT_PROPERTIES_ORIGIN } from './planTokens'
export type {
  FragmentInsertDocument,
  FragmentInsertPlan,
  FragmentInsertReport,
  FragmentInsertTarget,
  PlannedCustomProperties,
  PlannedFontFamily,
  PlannedScaleSteps,
  PlannedTable,
  PlannedTableCreate,
  PlannedTableReuse,
} from './planTypes'
