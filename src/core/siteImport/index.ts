/**
 * siteImport — public barrel for the Super Import pipeline.
 *
 * Phase 1: cssToStyleRules + associated types.
 * Phase 2: ingestInput, classifyFiles, buildImportPlan, commitImportPlan,
 *          applyConflictResolutions + all plan/result types.
 *
 * @see docs/features/site-import.md
 */

// ── Phase 1 ──────────────────────────────────────────────────────────────────

export { cssToStyleRules } from './cssToStyleRules'
export type { CssToStyleRulesOptions, CssToStyleRulesResult } from './cssToStyleRules'

// ── Phase 2 — input ingestion ─────────────────────────────────────────────────

export { ingestInput } from './ingestInput'
export type { IngestInput, IngestOptions } from './ingestInput'

// ── Phase 2 — file classification ────────────────────────────────────────────

export { classifyFiles } from './classifyFiles'

// ── Phase 2 — HTML page planning ──────────────────────────────────────────────

export { makeHtmlPagePlan, deriveSlug, prettifyTitle, resolveHref } from './htmlPagePlan'
export type { HtmlPagePlanResult } from './htmlPagePlan'

// ── Phase 2 — asset collection + URL normalisation ───────────────────────────

export { buildAssetPlan } from './assetPlan'
export type { CssFileResult, AssetPlanResult } from './assetPlan'

// ── Phase 2 — cross-stylesheet class semantics ───────────────────────────────

export {
  detectCrossSheetClassConflicts,
  applyCrossSheetClassResolutions,
  normalizeBindableClassRules,
  isSharedUtilityClassName,
} from './classCascades'

// ── Phase 2 — internal link rewriting (→ dynamic page refs) ──────────────────

export { rewriteInternalLinks } from './linkRewrite'

// ── Phase 2 — URL rewriting ───────────────────────────────────────────────────

export { applyAssetRewrites } from './applyAssetRewrites'

// ── Phase 2 — colour-token extraction ─────────────────────────────────────────

export { extractRootColorTokens, isCssColorValue } from './colorTokens'

// ── Phase 2 — font-token extraction ───────────────────────────────────────────

export { extractRootFontTokens } from './fontTokens'
export { extractGoogleFontImports, stripGoogleFontImportRules } from './fontImports'

// ── Phase 2 — conflict detection + resolution ─────────────────────────────────

export { detectConflicts, applyConflictResolutions } from './conflicts'
export type { ConflictDetectionResult } from './conflicts'

// ── Phase 2 — adapter interfaces ─────────────────────────────────────────────

export type { SiteImportAdapter, SiteImportTransaction } from './adapter'

// ── Phase 2 — top-level orchestration ────────────────────────────────────────

export { buildImportPlan, commitImportPlan } from './applyImport'
export type { BuildImportPlanInput } from './applyImport'

// ── Shared types ──────────────────────────────────────────────────────────────

export type {
  // Phase 1
  NewStyleRule,
  ImportWarning,
  ImportWarningKind,
  BreakpointHint,
  AssetRef,
  // Phase 2
  FileMap,
  FileRole,
  ClassifiedFile,
  PagePlan,
  PageScript,
  ConflictResolution,
  PageConflict,
  RuleConflict,
  TokenConflict,
  CrossSheetClassConflict,
  ImportPlan,
  ImportResult,
  StylesheetImportMode,
  LinkedStylesheet,
  ImportStylesheet,
  // @font-face import
  ParsedFontFace,
  ImportFontFile,
  ImportFontFamily,
  ImportGoogleFont,
  // colour tokens + scripts
  ImportColorToken,
  ImportFontToken,
  ImportScript,
} from './types'

// ── Error classes (callers need instanceof checks) ────────────────────────────

export {
  EmptyImportError,
  OversizeImportError,
  ZipBombError,
  TooManyFilesError,
  PathTraversalError,
} from './types'
