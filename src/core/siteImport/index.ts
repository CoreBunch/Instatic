/**
 * siteImport — public barrel for the Super Import pipeline.
 *
 * Phase 1: cssToStyleRules + associated types.
 * Phase 2: ingestInput, classifyFiles, buildImportPlan (buildPlan.ts),
 *          commitImportPlan (commitPlan.ts),
 *          applyConflictResolutions + all plan/result types.
 *
 * @see docs/features/site-import.md
 */

// ── Phase 1 ──────────────────────────────────────────────────────────────────

export { cssToStyleRules } from './cssToStyleRules'


// ── Phase 2 — input ingestion ─────────────────────────────────────────────────

export { ingestInput } from './ingestInput'
export { detectPluginPackage } from './pluginPackage'


// ── Phase 2 — file classification ────────────────────────────────────────────

export { classifyFiles } from './classifyFiles'

// ── Phase 2 — HTML page planning ──────────────────────────────────────────────

export { makeHtmlPagePlan, deriveSlug, prettifyTitle, resolveHref } from './htmlPagePlan'


// ── Phase 2 — asset collection + URL normalisation ───────────────────────────

export { buildAssetPlan } from './assetPlan'
export type { CssFileResult } from './assetPlan'

// ── Phase 2 — cross-stylesheet class semantics ───────────────────────────────

export { pageClassUsage, importClassNames } from './classUsage'

// ── Phase 2 — internal link rewriting (→ dynamic page refs) ──────────────────

export { rewriteInternalLinks } from './linkRewrite'

// ── Phase 2 — URL rewriting ───────────────────────────────────────────────────

export { applyAssetRewrites } from './applyAssetRewrites'

// ── Phase 2 — colour-token extraction ─────────────────────────────────────────

export { extractRootColorTokens, isCssColorValue } from './colorTokens'
export { normalizeImportedTokens } from './tokenNames'

// ── Phase 2 — font-token extraction ───────────────────────────────────────────

// ── Phase 2 — conflict detection + resolution ─────────────────────────────────

export { detectConflicts, applyConflictResolutions, withPageSlugs } from './conflicts'
export { hashImportAssets, detectMediaConflicts } from './mediaConflicts'
export type { ExistingMediaMatch } from './mediaConflicts'
export { importedSiteFilePath, importSourceHash, siteFileImportRecord, uniqueSiteFilePath } from './siteFilePaths'
export { mergeImportOrder, prioritiesForOrder } from './importOrder'


// ── Phase 2 — adapter interfaces ─────────────────────────────────────────────

export type { SiteImportAdapter, SiteImportTransaction } from './adapter'

// ── Phase 2 — top-level orchestration ────────────────────────────────────────

export { buildImportPlan } from './buildPlan'
export { commitImportPlan } from './commitPlan'

// ── Shared types ──────────────────────────────────────────────────────────────

export type {
  // Phase 1
  NewStyleRule,
  // Phase 2
  FileMap,
  FileRole,
  PagePlan,
  ImportPlan,
  ImportResult,
  ImportAsset,
  UploadedImportAsset,
  StylesheetImportMode,
  ImportStylesheet,
  // @font-face import
  ImportFontFamily,
  ImportGoogleFont,
  // colour tokens + scripts
  ImportColorToken,
  ImportFontToken,
  ImportScriptDependency,
  ImportScript,
} from './types'
export type { ImportWarning } from './warnings'
export type {
  ConflictResolution,
  PageConflict,
  RuleConflict,
  TokenConflict,
  CrossSheetClassConflict,
  FileConflict,
  FileConflictState,
  MediaConflict,
} from './conflictTypes'

// ── Error classes (callers need instanceof checks) ────────────────────────────

export {
  EmptyImportError,
  OversizeImportError,
  ZipBombError,
  TooManyFilesError,
  PathTraversalError,
} from './errors'

export {
  findReimportedStyleRule, indexStyleRulesByName, indexStyleRulesByOrigin,
  linkImportedClassNames, registerStyleRuleOrigin,
} from './importLinking'
export { insertImportedFragment, type FragmentInsertOptions } from './insertImportedFragment'
