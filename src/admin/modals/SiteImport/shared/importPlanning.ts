/**
 * importPlanning — pure plan-orchestration helpers for the Super Import wizard.
 *
 * Extracted from `SiteImportModal.tsx` to keep the component focused on render +
 * wizard state. Everything here is headless-ish glue: selection defaults, plan
 * filtering by selection, conflict-resolution merging, ingest-error formatting,
 * and the two site load/save bookends. No React, no JSX.
 */

import {
  applyConflictResolutions,
  type ImportPlan,
  type ConflictResolution,
  type PageConflict,
  type RuleConflict,
  type TokenConflict,
  type CrossSheetClassConflict,
  EmptyImportError,
  OversizeImportError,
  ZipBombError,
  TooManyFilesError,
  PathTraversalError,
} from '@core/siteImport'
import type { SiteDocument } from '@core/page-tree'
import { cmsAdapter } from '@core/persistence/cms'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
import { getErrorMessage } from '@core/utils/errorMessage'

/** Stable map key for a token conflict — the colour/font namespaces are joined. */
export function tokenConflictKey(conflict: Pick<TokenConflict, 'kind' | 'desiredVariable'>): string {
  return `${conflict.kind}:${conflict.desiredVariable}`
}

/** Stable map key for a cross-sheet class conflict — one row per divergent definition. */
export function crossSheetConflictKey(
  conflict: Pick<CrossSheetClassConflict, 'desiredName' | 'definitionId'>,
): string {
  return `${conflict.desiredName}:${conflict.definitionId}`
}

/** Which import categories the user has selected to commit, keyed per kind. */
export interface ImportSelection {
  pagesIncluded: Set<string>       // by source path
  styleRulesIncluded: Set<number>  // by index in plan.styleRules
  assetsIncluded: Set<string>      // by sourcePath
  fontsIncluded: Set<string>       // by font family
  scriptsIncluded: Set<string>     // by script path
  stylesheetsIncluded: Set<string> // by kept-stylesheet path (mode 'file')
}

/** Everything selected by default — the user opts OUT in the Review step. */
export function makeDefaultSelection(plan: ImportPlan): ImportSelection {
  return {
    pagesIncluded: new Set(plan.pages.map((p) => p.source)),
    styleRulesIncluded: new Set(plan.styleRules.map((_, i) => i)),
    assetsIncluded: new Set(plan.assets.map((a) => a.sourcePath)),
    fontsIncluded: new Set([
      ...plan.fonts.map((f) => f.family),
      ...plan.googleFonts.map((f) => f.family),
    ]),
    scriptsIncluded: new Set(plan.scripts.map((s) => s.path)),
    stylesheetsIncluded: new Set(plan.stylesheets.map((s) => s.path)),
  }
}

/** Narrow a plan to only the categories the user kept selected. */
export function filterPlanBySelection(plan: ImportPlan, selection: ImportSelection): ImportPlan {
  const fontTokens = plan.fontTokens.filter((t) => !t.family || selection.fontsIncluded.has(t.family))
  // A font-token conflict is only relevant when its token survived selection
  // filtering (a deselected font drops its token, so its conflict row is moot).
  // Colour-token conflicts always stand — colours aren't individually toggled.
  const includedFontVars = new Set(fontTokens.map((t) => t.variable))
  return {
    ...plan,
    pages: plan.pages.filter((p) => selection.pagesIncluded.has(p.source)),
    styleRules: plan.styleRules.filter((_, i) => selection.styleRulesIncluded.has(i)),
    // Keep styleRuleSources index-aligned with the filtered styleRules.
    styleRuleSources: plan.styleRuleSources.filter((_, i) => selection.styleRulesIncluded.has(i)),
    assets: plan.assets.filter((a) => selection.assetsIncluded.has(a.sourcePath)),
    fonts: plan.fonts.filter((f) => selection.fontsIncluded.has(f.family)),
    googleFonts: plan.googleFonts.filter((f) => selection.fontsIncluded.has(f.family)),
    fontTokens,
    scripts: plan.scripts
      .filter((s) => selection.scriptsIncluded.has(s.path))
      .map((script) => ({
        ...script,
        pageSources: script.pageSources.filter((source) => selection.pagesIncluded.has(source)),
      }))
      .filter((script) => script.pageSources.length > 0),
    stylesheets: plan.stylesheets
      .filter((s) => selection.stylesheetsIncluded.has(s.path))
      .map((sheet) => ({
        ...sheet,
        pageSources: sheet.pageSources.filter((source) => selection.pagesIncluded.has(source)),
      }))
      .filter((sheet) => sheet.pageSources.length > 0),
    conflicts: {
      ...plan.conflicts,
      tokens: plan.conflicts.tokens.filter(
        (c) => c.kind === 'color' || includedFontVars.has(c.desiredVariable),
      ),
      // A cross-sheet conflict only matters while ≥1 of its pages imports.
      crossSheetClasses: plan.conflicts.crossSheetClasses.filter((c) =>
        c.pageSources.some((source) => selection.pagesIncluded.has(source)),
      ),
    },
  }
}

/**
 * Merge the wizard's per-conflict resolution maps onto the plan's conflict
 * descriptors and run `applyConflictResolutions`, returning a plan ready for
 * `commitImportPlan`.
 */
export function buildResolvedPlan(
  plan: ImportPlan,
  pageResMap: Map<string, ConflictResolution>,
  ruleResMap: Map<string, ConflictResolution>,
  tokenResMap: Map<string, ConflictResolution>,
  crossSheetResMap: Map<string, ConflictResolution> = new Map(),
): ImportPlan {
  const updatedPageConflicts: PageConflict[] = plan.conflicts.pages.map((c) => ({
    ...c,
    defaultResolution: pageResMap.get(c.source) ?? c.defaultResolution,
  }))
  const updatedRuleConflicts: RuleConflict[] = plan.conflicts.rules.map((c) => ({
    ...c,
    defaultResolution: ruleResMap.get(c.desiredName) ?? c.defaultResolution,
  }))
  const updatedTokenConflicts: TokenConflict[] = plan.conflicts.tokens.map((c) => ({
    ...c,
    defaultResolution: tokenResMap.get(tokenConflictKey(c)) ?? c.defaultResolution,
  }))
  const updatedCrossSheetConflicts: CrossSheetClassConflict[] = plan.conflicts.crossSheetClasses.map((c) => ({
    ...c,
    defaultResolution: crossSheetResMap.get(crossSheetConflictKey(c)) ?? c.defaultResolution,
  }))
  return applyConflictResolutions(
    {
      ...plan,
      conflicts: {
        pages: updatedPageConflicts,
        rules: updatedRuleConflicts,
        tokens: updatedTokenConflicts,
        crossSheetClasses: updatedCrossSheetConflicts,
      },
    },
    updatedPageConflicts,
    updatedRuleConflicts,
    updatedTokenConflicts,
    updatedCrossSheetConflicts,
  )
}

function formatByteLimit(bytes: number): string {
  const mb = Math.round(bytes / (1024 * 1024))
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`
  return `${mb} MB`
}

/** Turn an ingest-stage error into a human-readable message for the Drop step. */
export function describeIngestError(err: unknown): string {
  if (err instanceof EmptyImportError) return 'No importable files found. Drop at least one HTML or CSS file.'
  if (err instanceof OversizeImportError) return `Import is too large (${Math.round(err.sizeBytes / 1024 / 1024)} MB). Maximum is ${formatByteLimit(err.limitBytes)}.`
  if (err instanceof ZipBombError) return 'ZIP archive is too large when uncompressed. Maximum uncompressed size is 5 GB.'
  if (err instanceof TooManyFilesError) return `Too many files (${err.count}). Maximum is ${err.limit}.`
  if (err instanceof PathTraversalError) return `Unsafe path detected: "${err.path}".`
  return getErrorMessage(err, 'Unknown import error')
}

/** Load (or lazily create) the draft site a static import will write into. */
export async function ensureCurrentSiteForStaticImport(): Promise<SiteDocument> {
  const existingSite = useEditorStore.getState().site
  if (existingSite) return existingSite

  const loadedSite = await cmsAdapter.loadSite('default')
  if (loadedSite) {
    useEditorStore.getState().loadSite(loadedSite)
    return loadedSite
  }

  return useEditorStore.getState().createSite('My Site')
}

/** Persist the freshly-imported draft site and broadcast a reload. */
export async function saveImportedDraftSite(): Promise<void> {
  const site = useEditorStore.getState().site
  if (!site) throw new Error('Import completed, but no draft site is loaded.')
  await cmsAdapter.saveSite(site)
  useEditorStore.getState().setHasUnsavedChanges(false)
  requestCmsSiteReload()
}
