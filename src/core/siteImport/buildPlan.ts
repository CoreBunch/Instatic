/**
 * buildImportPlan — the analysis half of the Super Import pipeline.
 *
 * PURE and synchronous. Classifies files, parses HTML and CSS, collects
 * assets, normalises URLs, detects conflicts. Returns an `ImportPlan` ready
 * for preview in the import wizard or direct commit via `commitImportPlan`
 * (`commitPlan.ts`).
 *
 * The orchestrator is straight-line phase calls; each phase is a named
 * function below. Adding a new analysis concern means adding one phase, not
 * threading more state through a 250-line body.
 */

import {
  classKindSelector,
  extractCssSelectorClasses,
  type SiteDocument,
} from '@core/page-tree'
import { compareVariants } from '@core/fonts'
import { expandLinkedCssImports } from './cssImports'
import { extractGoogleFontImports } from './fontImports'
import { classifyFiles } from './classifyFiles'
import { makeHtmlPagePlan } from './htmlPagePlan'
import { buildAssetPlan, type CssFileResult } from './assetPlan'
import { partitionLinkedStylesheets } from './stylesheetPlan'
import { detectCrossSheetClassConflicts } from './classCascades'
import { detectConflicts } from './conflicts'
import { createCssPlanState, parseCssSourceIntoPlan } from './planCss'
import { rewriteNpmCdnModuleImports } from './scriptDependencies'
import { mergeScriptOrder, type PageScriptSequence } from './scriptOrder'
import type {
  ClassifiedFile,
  FileMap,
  ImportPlan,
  ImportWarning,
  ImportGoogleFont,
  ImportScript,
  PagePlan,
  StylesheetImportMode,
} from './types'

interface BuildImportPlanInput {
  fileMap: FileMap
  currentSite: SiteDocument
  options?: {
    /** Tolerance in px for matching older @media max-width queries by frame width. Default: 10. */
    mediaTolerance?: number
    /**
     * Per-stylesheet import mode, keyed by the top-level linked CSS path
     * (FileMap key). Unlisted paths convert to editable style rules.
     */
    stylesheetModes?: Record<string, StylesheetImportMode>
  }
}

/**
 * Build a fully-analysed `ImportPlan` from a `FileMap` and the current site.
 *
 * This is a pure, synchronous function. Call it before showing the import
 * wizard so the user can preview what will be imported and resolve conflicts.
 */
export function buildImportPlan({ fileMap, currentSite, options }: BuildImportPlanInput): ImportPlan {
  const mediaTolerance = options?.mediaTolerance ?? 10
  const warnings: ImportWarning[] = []
  const droppedAtRules: string[] = []

  // 1. Classify every file.
  const classified = classifyFiles(fileMap)

  // 2. Process each HTML file into a raw PagePlan; collect inline CSS and
  //    page scripts along the way.
  const htmlPhase = collectHtmlPagePlans(classified, fileMap)
  warnings.push(...htmlPhase.warnings)
  const { rawPagePlans, inlineCssByPage, scripts } = htmlPhase

  // Google fonts are harvested from every CSS source (linked, kept, inline) —
  // one shared collector dedupes by family and merges variants/subsets.
  const googleFontsByFamily = new Map<string, ImportGoogleFont>()
  const collectGoogleFonts = (cssSource: string): void => {
    for (const font of extractGoogleFontImports(cssSource)) {
      const key = font.family.toLowerCase()
      const existing = googleFontsByFamily.get(key)
      if (!existing) {
        googleFontsByFamily.set(key, font)
        continue
      }
      existing.variants = [...new Set([...existing.variants, ...font.variants])].sort(compareVariants)
      existing.subsets = [...new Set([...existing.subsets, ...font.subsets])]
    }
  }

  // 2b. Catalogue top-level linked stylesheets by import mode; flatten the
  //     kept ones (`mode: 'file'`) verbatim. See stylesheetPlan.ts.
  const partition = partitionLinkedStylesheets(
    rawPagePlans,
    fileMap,
    options?.stylesheetModes ?? {},
    collectGoogleFonts,
  )
  warnings.push(...partition.warnings)
  droppedAtRules.push(...partition.droppedAtRules)
  const { linkedStylesheets, keptStylesheetPaths, rawStylesheetSources } = partition

  // 2c. Expand @imports of the CONVERTED sheets into a flat, ordered list of
  //     CSS sources (kept sheets bypass conversion entirely).
  const cssExpansion = expandConvertedCssSources(rawPagePlans, fileMap, keptStylesheetPaths, partition.usedCssPaths)
  warnings.push(...cssExpansion.warnings)
  droppedAtRules.push(...cssExpansion.droppedAtRules)
  const { cssSourcesByPath, orderedCssPaths, allLinkedCssPaths } = cssExpansion

  // 3. Record CSS files no page links to.
  const unusedCss = classified
    .filter((f) => f.role === 'css' && !allLinkedCssPaths.has(f.path))
    .map((f) => f.path)

  // 4. Parse every converted CSS source — external sheets first, then each
  //    page's `<style>` CSS as a synthetic per-page source. The synthetic
  //    cssPath `<htmlPath>::inline` keeps `url(...)` resolution relative to
  //    the HTML file's directory (dirname() drops the suffix) and is appended
  //    LAST to the page's linked paths so an inline `<style>` wins the cascade
  //    over external sheets for a shared class name. Both routes flow through
  //    the exact same parse → token → asset → conflict pipeline (planCss.ts).
  const cssPlan = createCssPlanState()
  const parseOptions = {
    breakpoints: currentSite.breakpoints.map((bp) => ({ id: bp.id, width: bp.width, mediaQuery: bp.mediaQuery })),
    mediaTolerance,
    collectGoogleFonts,
  }
  for (const cssPath of orderedCssPaths) {
    const cssSource = cssSourcesByPath.get(cssPath)
    if (!cssSource) continue
    parseCssSourceIntoPlan(cssPath, cssSource, cssPlan, parseOptions)
  }
  for (const plan of rawPagePlans) {
    const inlineCss = inlineCssByPage.get(plan.source)
    if (!inlineCss) continue
    const syntheticPath = `${plan.source}::inline`
    parseCssSourceIntoPlan(syntheticPath, inlineCss, cssPlan, parseOptions)
    plan.linkedCssPaths = [...plan.linkedCssPaths, syntheticPath]
  }
  warnings.push(...cssPlan.warnings)
  droppedAtRules.push(...cssPlan.droppedAtRules)

  // 4b. Detect divergent cross-sheet class definitions among the CONVERTED
  //     stylesheets. Converted sheets merge CSS-natively into the one global
  //     cascade; when two page cascades define the same class differently,
  //     that becomes an explicit conflict (default: rename with a suffix) for
  //     the wizard's Conflicts step — applied by
  //     `applyCrossSheetClassResolutions`, never silently here.
  const existingClassNames = Object.values(currentSite.styleRules)
    .filter((rule) => rule.kind === 'class')
    .map((rule) => rule.name)
  const crossSheetClasses = detectCrossSheetClassConflicts(
    rawPagePlans,
    cssPlan.cssFileResults,
    existingClassNames,
  )
  const publishableCssFileResults = addSelectorDependencyClasses(
    cssPlan.cssFileResults,
    currentSite,
  )

  // 5. Build asset plan — normalises URLs in node props, CSS values, and kept
  //    stylesheet text; resolves @font-face blocks; collects assets to upload.
  const { normalizedPagePlans, normalizedStyleRules, styleRuleSources, stylesheets, fonts, assets, warnings: assetWarnings } =
    buildAssetPlan(rawPagePlans, publishableCssFileResults, fileMap, rawStylesheetSources)
  warnings.push(...assetWarnings)

  // 6. Detect conflicts against the current site — pages, class rules, and
  //    design tokens (colour + font) all flow through one resolution model.
  const conflicts = detectConflicts(
    currentSite,
    normalizedPagePlans,
    normalizedStyleRules,
    [...cssPlan.colorsBySlug.values()],
    [...cssPlan.fontTokensByVariable.values()],
  )

  return {
    pages: normalizedPagePlans,
    styleRules: normalizedStyleRules,
    styleRuleSources,
    fonts,
    googleFonts: [...googleFontsByFamily.values()],
    conditions: [...cssPlan.conditionsById.values()],
    assets,
    colors: [...cssPlan.colorsBySlug.values()],
    fontTokens: [...cssPlan.fontTokensByVariable.values()],
    scripts,
    linkedStylesheets,
    stylesheets,
    conflicts: { ...conflicts, crossSheetClasses },
    warnings,
    droppedAtRules,
    unusedCss,
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — HTML files → raw PagePlans + inline CSS + page scripts
// ---------------------------------------------------------------------------

interface HtmlPhaseResult {
  rawPagePlans: PagePlan[]
  /** Per-page CSS harvested from `<style>` blocks, keyed by pagePlan.source. */
  inlineCssByPage: Map<string, string>
  scripts: ImportScript[]
  warnings: ImportWarning[]
}

/** Priorities start here so hand-added scripts (default 100) sort alongside imported ones. */
const FIRST_SCRIPT_PRIORITY = 100

function collectHtmlPagePlans(classified: ClassifiedFile[], fileMap: FileMap): HtmlPhaseResult {
  const warnings: ImportWarning[] = []
  const rawPagePlans: PagePlan[] = []
  const inlineCssByPage = new Map<string, string>()
  const scriptsByPath = new Map<string, Omit<ImportScript, 'pageSources' | 'priority'> & {
    pageSources: Set<string>
  }>()
  // Each page's scripts in document order; merged into one load order below.
  const sequences: PageScriptSequence[] = []

  for (const f of classified) {
    if (f.role !== 'html') continue
    const htmlSource = decodeUtf8(f.bytes)
    const { pagePlan, warnings: pageWarnings, inlineCss } = makeHtmlPagePlan(f.path, htmlSource, fileMap)
    warnings.push(...pageWarnings)
    rawPagePlans.push(pagePlan)
    if (inlineCss.trim().length > 0) inlineCssByPage.set(pagePlan.source, inlineCss)

    const sequence: string[] = []
    for (const pageScript of pagePlan.scripts) {
      const scriptPath = pageScript.path
      const existing = scriptsByPath.get(scriptPath)
      if (existing) {
        existing.pageSources.add(pagePlan.source)
        if (!sequence.includes(scriptPath)) sequence.push(scriptPath)
        continue
      }

      const content = pageScript.kind === 'inline'
        ? pageScript.content
        : decodeExternalScript(fileMap, pageScript.path)
      if (content === null) continue
      const script = normalizeImportedScriptContent(content, pageScript.format)

      scriptsByPath.set(scriptPath, {
        path: scriptPath,
        content: script.content,
        format: pageScript.format,
        dependencies: script.dependencies,
        pageSources: new Set([pagePlan.source]),
      })
      sequence.push(scriptPath)
    }
    sequences.push({ source: pagePlan.source, paths: sequence })
  }

  // One `priority` per script has to honour every page's document order at
  // once — a per-file counter that numbers a script on first sight cannot,
  // once two pages share a file (#403).
  const merged = mergeScriptOrder(sequences)
  warnings.push(...merged.warnings)
  const scripts: ImportScript[] = merged.order.map((path, index) => {
    const script = scriptsByPath.get(path)!
    return {
      ...script,
      pageSources: [...script.pageSources],
      priority: FIRST_SCRIPT_PRIORITY + index,
    }
  })
  return { rawPagePlans, inlineCssByPage, scripts, warnings }
}

// ---------------------------------------------------------------------------
// Phase 2c — expand @imports of converted sheets into ordered CSS sources
// ---------------------------------------------------------------------------

interface CssExpansionResult {
  cssSourcesByPath: Map<string, string>
  orderedCssPaths: string[]
  /** Every CSS path any page uses (kept + converted + expanded @imports). */
  allLinkedCssPaths: Set<string>
  warnings: ImportWarning[]
  droppedAtRules: string[]
}

/**
 * Expand the converted top-level sheets' `@import` chains per page, mutating
 * each plan's `linkedCssPaths` to the expanded list, and return the deduped
 * CSS sources in first-seen order (= cascade order across pages).
 */
function expandConvertedCssSources(
  rawPagePlans: PagePlan[],
  fileMap: FileMap,
  keptStylesheetPaths: ReadonlySet<string>,
  usedCssPaths: Iterable<string>,
): CssExpansionResult {
  const warnings: ImportWarning[] = []
  const droppedAtRules: string[] = []
  const cssSourcesByPath = new Map<string, string>()
  const orderedCssPaths: string[] = []
  const allLinkedCssPaths = new Set<string>(usedCssPaths)

  for (const plan of rawPagePlans) {
    // Kept stylesheets bypass conversion entirely — only the converted sheets
    // join the page's cascade of parsed rules.
    const convertedTopLevel = plan.linkedCssPaths.filter((cssPath) => !keptStylesheetPaths.has(cssPath))
    const expanded = expandLinkedCssImports(convertedTopLevel, fileMap)
    warnings.push(...expanded.warnings)
    for (const w of expanded.warnings) {
      if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
    }
    plan.linkedCssPaths = expanded.cssPaths
    for (const cssPath of expanded.cssPaths) allLinkedCssPaths.add(cssPath)
    for (const source of expanded.sources) {
      if (cssSourcesByPath.has(source.cssPath)) continue
      cssSourcesByPath.set(source.cssPath, source.cssSource)
      orderedCssPaths.push(source.cssPath)
    }
  }

  return { cssSourcesByPath, orderedCssPaths, allLinkedCssPaths, warnings, droppedAtRules }
}

// ---------------------------------------------------------------------------
// Phase 4b helper — make every selector class available to the class picker
// ---------------------------------------------------------------------------

const INVALID_CLASS_ATTRIBUTE_TOKEN_RE = /[\s\u007f]/u

/**
 * Complex selectors expose their rightmost class as their bindable class rule
 * (`.group:hover .group-hover\:block` binds `group-hover:block`). Ancestor and
 * dependency classes such as `group`, `peer`, or `dark` may never own a
 * declaration block of their own, but users still need to pick and assign
 * them. Add one bare registry class for every selector class name that has no
 * bindable rule in the incoming CSS or existing site.
 *
 * Bare entries add no CSS. They are assignment/index records; the publisher's
 * selector-dependency tree-shaker emits ambient fragments when their known
 * class dependencies are in use.
 */
function addSelectorDependencyClasses(
  cssFileResults: CssFileResult[],
  currentSite: SiteDocument,
): CssFileResult[] {
  const bindableNames = new Set(
    Object.values(currentSite.styleRules)
      .filter((rule) => rule.kind === 'class')
      .map((rule) => rule.name),
  )
  for (const file of cssFileResults) {
    for (const rule of file.rules) {
      if (rule.kind === 'class') bindableNames.add(rule.name)
    }
  }

  const firstSourceByMissingName = new Map<string, number>()
  for (let fileIndex = 0; fileIndex < cssFileResults.length; fileIndex += 1) {
    for (const rule of cssFileResults[fileIndex].rules) {
      if (rule.rawCss) continue
      for (const token of extractCssSelectorClasses(rule.selector)) {
        if (
          bindableNames.has(token.name)
          || firstSourceByMissingName.has(token.name)
          || INVALID_CLASS_ATTRIBUTE_TOKEN_RE.test(token.name)
        ) {
          continue
        }
        firstSourceByMissingName.set(token.name, fileIndex)
      }
    }
  }

  if (firstSourceByMissingName.size === 0) return cssFileResults

  const additionsByFile = new Map<number, string[]>()
  for (const [name, fileIndex] of firstSourceByMissingName) {
    const names = additionsByFile.get(fileIndex) ?? []
    names.push(name)
    additionsByFile.set(fileIndex, names)
  }

  return cssFileResults.map((file, fileIndex) => {
    const additions = additionsByFile.get(fileIndex)
    if (!additions?.length) return file
    const baseOrder = file.rules.length
    return {
      ...file,
      rules: [
        ...file.rules,
        ...additions.map((name, index) => ({
          name,
          kind: 'class' as const,
          selector: classKindSelector(name),
          order: baseOrder + index,
          styles: {},
          contextStyles: {},
        })),
      ],
    }
  })
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

/** Decode UTF-8 bytes to a string. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function decodeExternalScript(fileMap: FileMap, path: string): string | null {
  const file = fileMap.files[path]
  return file ? decodeUtf8(file.bytes) : null
}

function normalizeImportedScriptContent(
  content: string,
  format: ImportScript['format'],
): Pick<ImportScript, 'content' | 'dependencies'> {
  if (format !== 'module') return { content }
  const rewritten = rewriteNpmCdnModuleImports(content)
  return rewritten.dependencies.length > 0
    ? { content: rewritten.content, dependencies: rewritten.dependencies }
    : { content }
}
