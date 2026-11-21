/**
 * importPlanning — pure plan-orchestration helpers for the Super Import wizard.
 *
 * Extracted from `SiteImportModal.tsx` to keep the component focused on render +
 * wizard state. Everything here is headless-ish glue: selection defaults, plan
 * filtering by selection, conflict-resolution merging, the media library
 * lookup, ingest-error formatting, and the two site load/save bookends.
 * No React, no JSX.
 */

import {
  applyConflictResolutions,
  importClassNames,
  pageClassUsage,
  detectMediaConflicts,
  hashImportAssets,
  type ImportGoogleFont,
  type ImportPlan,
  type ImportStylesheet,
  type ConflictResolution,
  type PageConflict,
  type RuleConflict,
  type TokenConflict,
  type CrossSheetClassConflict,
  type FileConflict,
  EmptyImportError,
  OversizeImportError,
  ZipBombError,
  TooManyFilesError,
  PathTraversalError,
} from '@core/siteImport'
import { validateCssClassName, type SiteDocument } from '@core/page-tree'
import { cmsAdapter } from '@core/persistence/cms'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
import { getErrorMessage } from '@core/utils/errorMessage'
import { findCmsMediaByContentHash } from '@core/persistence/cmsMedia'
import { isAbortError } from '@core/http'
import { pushToast } from '@ui/components/Toast'

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

/** Stable key for a class-name row (site-vs-import or cross-sheet) in rename validation. */
export function classRowKey(kind: 'rule' | 'cross-sheet', key: string): string {
  return `${kind}:${key}`
}

/** The site's class names, which rename targets must keep clear of. */
export function siteClassNameSet(site: Pick<SiteDocument, 'styleRules'>): ReadonlySet<string> {
  return new Set(Object.values(site.styleRules).filter((rule) => rule.kind === 'class').map((rule) => rule.name))
}

/**
 * Field-local problems with the class names the Conflicts step would rename
 * to, keyed by `classRowKey`. Every rename target (site-vs-import class rows
 * and cross-sheet rows alike) must be a valid class name that no other row
 * targets, that is not already a class in the site, and that the import does
 * not bring in under that name itself. The one allowed reuse is a cross-sheet
 * row's own default: it names the class an earlier import of the same sheet
 * created, which the commit reconciles in place.
 */
export function classRenameProblems(
  plan: ImportPlan,
  siteClassNames: ReadonlySet<string>,
  ruleResMap: Map<string, ConflictResolution>,
  crossSheetResMap: Map<string, ConflictResolution>,
): Map<string, string> {
  const targets: Array<{ key: string; name: string; reusesSite: boolean }> = []
  const renameTarget = (res: ConflictResolution) =>
    (res.action === 'auto-rename' || res.action === 'custom-rename') ? res.resolvedName ?? null : null
  for (const conflict of plan.conflicts.rules) {
    const name = renameTarget(ruleResMap.get(conflict.desiredName) ?? conflict.defaultResolution)
    if (name !== null) targets.push({ key: classRowKey('rule', conflict.desiredName), name, reusesSite: false })
  }
  for (const conflict of plan.conflicts.crossSheetClasses) {
    const res = crossSheetResMap.get(crossSheetConflictKey(conflict)) ?? conflict.defaultResolution
    const name = renameTarget(res)
    if (name === null) continue
    const reusesSite = conflict.defaultResolution.resolvedName === name && siteClassNames.has(name)
    targets.push({ key: classRowKey('cross-sheet', crossSheetConflictKey(conflict)), name, reusesSite })
  }

  const importedNames = importClassNames(pageClassUsage(plan.pages, plan.scripts), plan.styleRules)
  const counts = new Map<string, number>()
  for (const { name } of targets) counts.set(name, (counts.get(name) ?? 0) + 1)
  const problems = new Map<string, string>()
  for (const target of targets) {
    if (validateCssClassName(target.name)) {
      problems.set(target.key, `"${target.name}" is not a valid class name`)
    } else if ((counts.get(target.name) ?? 0) > 1) {
      problems.set(target.key, `Another conflict also renames to "${target.name}"`)
    } else if (siteClassNames.has(target.name) && !target.reusesSite) {
      problems.set(target.key, `"${target.name}" is already a class in this site`)
    } else if (importedNames.has(target.name)) {
      problems.set(target.key, `The import already brings a "${target.name}" class`)
    }
  }
  return problems
}

/** Stable map key for a file conflict — a script and a stylesheet may share a path. */
export function fileConflictKey(conflict: Pick<FileConflict, 'kind' | 'path'>): string {
  return `${conflict.kind}:${conflict.path}`
}

/** Which import categories the user has selected to commit, keyed per kind. */
export interface ImportSelection {
  pagesIncluded: Set<string>       // by source path
  styleRulesIncluded: Set<number>  // by index in plan.styleRules
  assetsIncluded: Set<string>      // by sourcePath
  fontsIncluded: Set<string>       // by font family
  scriptsIncluded: Set<string>     // by script path
  stylesheetsIncluded: Set<string> // by stylesheet-file path (kept or site-wide)
}

/** A stylesheet no imported page links: it imports as a site-wide file. */
export function isSiteWideStylesheet(sheet: Pick<ImportStylesheet, 'pageSources'>): boolean {
  return sheet.pageSources.length === 0
}

/**
 * Everything selected by default — the user opts OUT in the Review step.
 *
 * One exception: a stylesheet no page links, in an import that has pages.
 * Those pages never loaded it (a template's unminified copy, an RTL sheet, an
 * alternate skin), so applying it to every page would change how they look.
 * It is offered switched off. With no pages in the import the stylesheet is
 * what the owner came to import, so it stays on.
 *
 * Every font family starts switched on, including a Google font only an
 * off sheet `@import`s. `isGoogleFontRequested` keeps that one out of the
 * import and shows it off; it follows the sheet if the user switches it on.
 */
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
    stylesheetsIncluded: new Set(
      plan.stylesheets
        .filter((s) => !isSiteWideStylesheet(s) || plan.pages.length === 0)
        .map((s) => s.path),
    ),
  }
}

/** How many things the selection would import. Zero means there is nothing to continue with. */
export function selectedImportCount(plan: ImportPlan, selection: ImportSelection): number {
  return (
    selection.pagesIncluded.size +
    selection.styleRulesIncluded.size +
    selection.stylesheetsIncluded.size +
    selection.assetsIncluded.size +
    plan.fonts.filter((font) => selection.fontsIncluded.has(font.family)).length +
    selectedGoogleFonts(plan, selection).length
  )
}

/**
 * The stylesheet files the selection imports. A kept linked sheet follows its
 * pages: it is narrowed to the selected ones and dropped when none is left.
 * A site-wide sheet has no page scope to narrow; it stands on its own.
 */
function selectedStylesheets(plan: ImportPlan, selection: ImportSelection): ImportStylesheet[] {
  return plan.stylesheets
    .filter((s) => selection.stylesheetsIncluded.has(s.path))
    .flatMap((sheet) => {
      if (isSiteWideStylesheet(sheet)) return [sheet]
      const pageSources = sheet.pageSources.filter((source) => selection.pagesIncluded.has(source))
      return pageSources.length > 0 ? [{ ...sheet, pageSources }] : []
    })
}

/**
 * Whether anything the selection imports still asks for this Google font.
 *
 * Converted CSS always does. A family only stylesheet files `@import` is
 * wanted only while one of those sheets imports; when the user switched them
 * all off, installing it would leave a self-hosted font nothing uses. This is
 * the one place that rule lives: the Review step shows such a font switched
 * off and the filtered plan leaves it out.
 */
export function isGoogleFontRequested(
  plan: ImportPlan,
  selection: ImportSelection,
  font: Pick<ImportGoogleFont, 'requestedByConvertedCss' | 'stylesheetPaths'>,
): boolean {
  if (font.requestedByConvertedCss) return true
  const importedSheets = new Set(selectedStylesheets(plan, selection).map((sheet) => sheet.path))
  return font.stylesheetPaths.some((path) => importedSheets.has(path))
}

/** The Google fonts the selection installs: switched on, and still requested. */
export function selectedGoogleFonts(plan: ImportPlan, selection: ImportSelection): ImportGoogleFont[] {
  return plan.googleFonts.filter(
    (font) => selection.fontsIncluded.has(font.family) && isGoogleFontRequested(plan, selection, font),
  )
}

/** Narrow a plan to only the categories the user kept selected. */
export function filterPlanBySelection(plan: ImportPlan, selection: ImportSelection): ImportPlan {
  const scripts = plan.scripts
    .filter((s) => selection.scriptsIncluded.has(s.path))
    .map((script) => ({
      ...script,
      pageSources: script.pageSources.filter((source) => selection.pagesIncluded.has(source)),
    }))
    .filter((script) => script.pageSources.length > 0)
  const stylesheets = selectedStylesheets(plan, selection)
  const importedFiles = new Set([
    ...scripts.map((s) => fileConflictKey({ kind: 'script', path: s.path })),
    ...stylesheets.map((s) => fileConflictKey({ kind: 'style', path: s.path })),
  ])
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
    googleFonts: selectedGoogleFonts(plan, selection),
    fontTokens,
    scripts,
    stylesheets,
    conflicts: {
      ...plan.conflicts,
      tokens: plan.conflicts.tokens.filter(
        (c) => c.kind === 'color' || includedFontVars.has(c.desiredVariable),
      ),
      // A cross-sheet conflict only matters while ≥1 of its pages imports.
      crossSheetClasses: plan.conflicts.crossSheetClasses.filter((c) =>
        c.pageSources.some((source) => selection.pagesIncluded.has(source)),
      ),
      // A file or media conflict only matters while that file still imports.
      files: plan.conflicts.files.filter((c) => importedFiles.has(fileConflictKey(c))),
      media: plan.conflicts.media.filter((c) => selection.assetsIncluded.has(c.sourcePath)),
    },
  }
}

/**
 * The wizard's per-conflict choices, one map per conflict category, keyed the
 * way each category's rows are keyed.
 */
export interface ConflictResolutionMaps {
  /** Keyed by the page's source path. */
  pages: Map<string, ConflictResolution>
  /** Keyed by the class name. */
  rules: Map<string, ConflictResolution>
  /** Keyed by `tokenConflictKey`. */
  tokens: Map<string, ConflictResolution>
  /** Keyed by `crossSheetConflictKey`. */
  crossSheetClasses: Map<string, ConflictResolution>
  /** Keyed by `fileConflictKey`. */
  files: Map<string, ConflictResolution>
  /** Keyed by the imported file's source path. */
  media: Map<string, ConflictResolution>
}

export type ConflictCategory = keyof ConflictResolutionMaps

export function emptyConflictResolutionMaps(): ConflictResolutionMaps {
  return {
    pages: new Map(),
    rules: new Map(),
    tokens: new Map(),
    crossSheetClasses: new Map(),
    files: new Map(),
    media: new Map(),
  }
}

/** Every conflict in the plan at its default resolution. */
export function defaultConflictResolutions(plan: ImportPlan): ConflictResolutionMaps {
  const { conflicts } = plan
  return {
    pages: new Map(conflicts.pages.map((c) => [c.source, c.defaultResolution])),
    rules: new Map(conflicts.rules.map((c) => [c.desiredName, c.defaultResolution])),
    tokens: new Map(conflicts.tokens.map((c) => [tokenConflictKey(c), c.defaultResolution])),
    crossSheetClasses: new Map(conflicts.crossSheetClasses.map((c) => [crossSheetConflictKey(c), c.defaultResolution])),
    files: new Map(conflicts.files.map((c) => [fileConflictKey(c), c.defaultResolution])),
    media: new Map(conflicts.media.map((c) => [c.sourcePath, c.defaultResolution])),
  }
}

/**
 * Merge the wizard's per-conflict resolution maps onto the plan's conflict
 * descriptors and run `applyConflictResolutions`, returning a plan ready for
 * `commitImportPlan`. File and media choices ride on the plan's conflicts;
 * the commit reads them there.
 */
export function buildResolvedPlan(plan: ImportPlan, choices: ConflictResolutionMaps): ImportPlan {
  const withChoice = <T extends { defaultResolution: ConflictResolution }>(
    conflicts: T[],
    map: Map<string, ConflictResolution>,
    key: (conflict: T) => string,
  ): T[] => conflicts.map((c) => ({ ...c, defaultResolution: map.get(key(c)) ?? c.defaultResolution }))

  const conflicts: ImportPlan['conflicts'] = {
    pages: withChoice<PageConflict>(plan.conflicts.pages, choices.pages, (c) => c.source),
    rules: withChoice<RuleConflict>(plan.conflicts.rules, choices.rules, (c) => c.desiredName),
    tokens: withChoice<TokenConflict>(plan.conflicts.tokens, choices.tokens, tokenConflictKey),
    crossSheetClasses: withChoice<CrossSheetClassConflict>(
      plan.conflicts.crossSheetClasses,
      choices.crossSheetClasses,
      crossSheetConflictKey,
    ),
    files: withChoice(plan.conflicts.files, choices.files, fileConflictKey),
    media: withChoice(plan.conflicts.media, choices.media, (c) => c.sourcePath),
  }
  return applyConflictResolutions(
    { ...plan, conflicts },
    conflicts.pages,
    conflicts.rules,
    conflicts.tokens,
    conflicts.crossSheetClasses,
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

/**
 * Mark the planned media the library already holds, so a re-import reuses
 * those files instead of uploading copies. Best effort: when the lookup
 * fails the import still works, it just uploads every file, and a warning
 * toast says so. `signal` aborts the lookup when a newer plan build
 * supersedes this one.
 */
export async function withMediaAlreadyInLibrary(plan: ImportPlan, signal?: AbortSignal): Promise<ImportPlan> {
  try {
    const hashBySource = await hashImportAssets(plan.assets)
    const matches = await findCmsMediaByContentHash([...new Set(hashBySource.values())], { signal })
    return detectMediaConflicts(plan, hashBySource, matches)
  } catch (err) {
    // A superseded build was aborted on purpose; its caller drops the plan.
    if (isAbortError(err)) return plan
    console.error('[SiteImportModal] media lookup failed:', err)
    pushToast({
      kind: 'warning',
      title: 'Could not check the Media Library',
      body: `Every file will be uploaded, including any already there. ${getErrorMessage(err, 'Unknown error')}`,
    })
    return plan
  }
}

/** Load (or lazily create) the draft site a static import will write into. */
export async function ensureCurrentSiteForStaticImport(): Promise<SiteDocument> {
  const existingSite = useEditorStore.getState().site
  if (existingSite) return existingSite

  const loaded = await cmsAdapter.loadSite('default')
  if (loaded) {
    useEditorStore.getState().loadSite(loaded.site)
    return loaded.site
  }

  return useEditorStore.getState().createSite('My Site')
}

/** Persist the freshly-imported draft site and broadcast a reload. */
export async function saveImportedDraftSite(): Promise<void> {
  const site = useEditorStore.getState().site
  if (!site) throw new Error('Import completed, but no draft site is loaded.')
  // Replace-mode full save — an import deliberately replaces whatever is
  // stored. This is an out-of-relay write, so the collab relay resets the
  // affected docs and every connected editor rebinds to the imported state.
  await cmsAdapter.saveSite(site)
  requestCmsSiteReload()
}
