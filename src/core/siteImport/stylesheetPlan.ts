/**
 * stylesheetPlan — catalogue the top-level linked stylesheets and flatten the
 * ones kept as files (`mode: 'file'`).
 *
 * A kept stylesheet bypasses conversion entirely: its unconditional local
 * `@import` graph is inlined in cascade order, trusted Google-font `@import`s
 * are stripped (they install as self-hosted fonts via the caller's
 * collector), and everything else stays byte-faithful. `url(...)`
 * normalisation happens later in `buildAssetPlan`, per part, so relative
 * paths resolve against each source file's own directory.
 */

import { expandLinkedCssImports } from './cssImports'
import { stripGoogleFontImportRules } from './fontImports'
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
  warnings: ImportWarning[]
  droppedAtRules: string[]
}

export function partitionLinkedStylesheets(
  pagePlans: readonly PagePlan[],
  fileMap: FileMap,
  stylesheetModes: Record<string, StylesheetImportMode>,
  collectGoogleFonts: (cssSource: string) => void,
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
  let nextPriority = 100
  for (const entry of linkedStylesheets) {
    if (entry.mode !== 'file') continue
    const expanded = expandLinkedCssImports([entry.path], fileMap)
    warnings.push(...expanded.warnings)
    for (const w of expanded.warnings) {
      if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
    }
    for (const cssPath of expanded.cssPaths) usedCssPaths.add(cssPath)
    const parts = expanded.sources.map((source) => {
      collectGoogleFonts(source.cssSource)
      return { cssPath: source.cssPath, cssText: stripGoogleFontImportRules(source.cssSource) }
    })
    rawStylesheetSources.push({
      path: entry.path,
      pageSources: entry.pageSources,
      priority: nextPriority,
      parts,
    })
    nextPriority += 1
  }

  return {
    linkedStylesheets,
    keptStylesheetPaths: new Set(rawStylesheetSources.map((sheet) => sheet.path)),
    rawStylesheetSources,
    usedCssPaths,
    warnings,
    droppedAtRules,
  }
}
