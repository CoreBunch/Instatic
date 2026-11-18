/**
 * stylesheetPlan — catalogue the top-level linked stylesheets and flatten the
 * ones kept as files (`mode: 'file'`), then pick up the stylesheets no page
 * links as site-wide files.
 *
 * A kept stylesheet bypasses conversion entirely: its unconditional local
 * `@import` graph is inlined in cascade order, trusted Google-font `@import`s
 * are stripped (they install as self-hosted fonts via the caller's
 * collector), and everything else stays byte-faithful. `url(...)`
 * normalisation happens later in `buildAssetPlan`, per part, so relative
 * paths resolve against each source file's own directory.
 */

import { expandLinkedCssImports } from './cssImports'
import { stripGoogleFontImportRules, type GoogleFontCollector } from './fontImports'
import type { RawStylesheetSource } from './assetPlan'
import type {
  FileMap,
  ImportWarning,
  LinkedStylesheet,
  PagePlan,
  StylesheetImportMode,
} from './types'

interface StylesheetPartition {
  /** Every top-level linked sheet with its import mode, in discovery order. */
  linkedStylesheets: LinkedStylesheet[]
  /** Top-level paths kept as files — excluded from the conversion cascade. */
  keptStylesheetPaths: Set<string>
  /** Kept sheets, flattened into per-source parts for `buildAssetPlan`. */
  rawStylesheetSources: RawStylesheetSource[]
  /** Expanded CSS paths consumed by kept sheets — they count as "used". */
  usedCssPaths: Set<string>
  /** First free cascade priority after the kept sheets. */
  nextPriority: number
  warnings: ImportWarning[]
  droppedAtRules: string[]
}

export function partitionLinkedStylesheets(
  pagePlans: readonly PagePlan[],
  fileMap: FileMap,
  stylesheetModes: Record<string, StylesheetImportMode>,
  collectGoogleFonts: GoogleFontCollector,
): StylesheetPartition {
  const warnings: ImportWarning[] = []
  const droppedAtRules: string[] = []
  const usedCssPaths = new Set<string>()

  const linkedStylesheets: LinkedStylesheet[] = []
  const byPath = new Map<string, LinkedStylesheet>()
  for (const plan of pagePlans) {
    for (const cssPath of plan.linkedCssPaths) {
      let entry = byPath.get(cssPath)
      if (!entry) {
        entry = {
          path: cssPath,
          mode: stylesheetModes[cssPath] === 'file' ? 'file' : 'convert',
          pageSources: [],
        }
        byPath.set(cssPath, entry)
        linkedStylesheets.push(entry)
      }
      if (!entry.pageSources.includes(plan.source)) entry.pageSources.push(plan.source)
    }
  }

  const rawStylesheetSources: RawStylesheetSource[] = []
  let nextPriority = FIRST_STYLESHEET_PRIORITY
  for (const entry of linkedStylesheets) {
    if (entry.mode !== 'file') continue
    const flattened = flattenStylesheet(entry.path, fileMap, collectGoogleFonts)
    warnings.push(...flattened.warnings)
    droppedAtRules.push(...flattened.droppedAtRules)
    for (const cssPath of flattened.cssPaths) usedCssPaths.add(cssPath)
    rawStylesheetSources.push({
      path: entry.path,
      pageSources: entry.pageSources,
      priority: nextPriority,
      parts: flattened.parts,
    })
    nextPriority += 1
  }

  return {
    linkedStylesheets,
    keptStylesheetPaths: new Set(rawStylesheetSources.map((sheet) => sheet.path)),
    rawStylesheetSources,
    usedCssPaths,
    nextPriority,
    warnings,
    droppedAtRules,
  }
}

interface UnlinkedStylesheets {
  /** One site-wide sheet per unlinked root, flattened like a kept sheet. */
  rawStylesheetSources: RawStylesheetSource[]
  warnings: ImportWarning[]
  droppedAtRules: string[]
}

/**
 * Plan the CSS files no imported page links as stylesheet files for the whole site.
 *
 * Such a file has no page cascade to convert into, so it imports verbatim as
 * a `SiteFile` applied to every page (`pageSources: []`), flattened exactly
 * like a kept linked sheet. A file that another unlinked file `@import`s is
 * part of that file, not a sheet of its own. Roots are taken in FileMap order
 * so an `@import` cycle among unlinked files still yields one sheet.
 */
export function collectUnlinkedStylesheets(
  unlinkedCssPaths: readonly string[],
  fileMap: FileMap,
  collectGoogleFonts: GoogleFontCollector,
  firstPriority: number,
): UnlinkedStylesheets {
  const warnings: ImportWarning[] = []
  const droppedAtRules: string[] = []

  const importedByAnother = new Set<string>()
  for (const cssPath of unlinkedCssPaths) {
    for (const part of expandLinkedCssImports([cssPath], fileMap).cssPaths) {
      if (part !== cssPath) importedByAnother.add(part)
    }
  }
  // Uncontested roots first, then whatever a cycle left without one.
  const candidates = [
    ...unlinkedCssPaths.filter((cssPath) => !importedByAnother.has(cssPath)),
    ...unlinkedCssPaths.filter((cssPath) => importedByAnother.has(cssPath)),
  ]

  const covered = new Set<string>()
  const roots: Array<{ path: string; parts: RawStylesheetSource['parts'] }> = []
  for (const cssPath of candidates) {
    if (covered.has(cssPath)) continue
    const flattened = flattenStylesheet(cssPath, fileMap, collectGoogleFonts)
    warnings.push(...flattened.warnings)
    droppedAtRules.push(...flattened.droppedAtRules)
    for (const part of flattened.cssPaths) covered.add(part)
    roots.push({ path: cssPath, parts: flattened.parts })
  }

  // Cascade priority follows FileMap order, not the order roots were found in.
  const fileOrder = new Map(unlinkedCssPaths.map((cssPath, index) => [cssPath, index]))
  roots.sort((a, b) => (fileOrder.get(a.path) ?? 0) - (fileOrder.get(b.path) ?? 0))

  return {
    rawStylesheetSources: roots.map((root, index) => ({
      path: root.path,
      pageSources: [],
      priority: firstPriority + index,
      parts: root.parts,
    })),
    warnings,
    droppedAtRules,
  }
}

/** Priorities start here so hand-added stylesheets (default 100) sort alongside imported ones. */
const FIRST_STYLESHEET_PRIORITY = 100

interface FlattenedStylesheet {
  /** Every CSS path the sheet consumes: itself plus its local `@import` graph. */
  cssPaths: string[]
  parts: RawStylesheetSource['parts']
  warnings: ImportWarning[]
  droppedAtRules: string[]
}

/** Expand one sheet's local `@import` graph into verbatim per-source parts. */
function flattenStylesheet(
  cssPath: string,
  fileMap: FileMap,
  collectGoogleFonts: GoogleFontCollector,
): FlattenedStylesheet {
  const expanded = expandLinkedCssImports([cssPath], fileMap)
  const droppedAtRules: string[] = []
  for (const w of expanded.warnings) {
    if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
  }
  const parts = expanded.sources.map((source) => {
    collectGoogleFonts(source.cssSource, cssPath)
    return { cssPath: source.cssPath, cssText: stripGoogleFontImportRules(source.cssSource) }
  })
  return { cssPaths: expanded.cssPaths, parts, warnings: expanded.warnings, droppedAtRules }
}
