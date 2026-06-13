/**
 * CSS-source parsing phase of `buildImportPlan`.
 *
 * ONE parse path for both kinds of CSS the importer meets — external
 * stylesheets and per-page inline `<style>` blocks (fed in as synthetic
 * `<htmlPath>::inline` sources). Each call runs the full
 * parse → condition-dedupe → colour-token → font-token pipeline and appends
 * the resulting `CssFileResult` to the shared accumulator state.
 *
 * This used to be two copy-pasted loops inside `buildImportPlan`; any rule
 * added to one path (a new token extractor, a new warning kind) silently
 * missed the other. Now there is exactly one place to extend.
 */

import type { ConditionDef } from '@core/page-tree'
import { cssToStyleRules } from './cssToStyleRules'
import { extractRootColorTokens } from './colorTokens'
import { extractRootFontTokens } from './fontTokens'
import { stripGoogleFontImportRules } from './fontImports'
import type { CssFileResult } from './assetPlan'
import type { ImportColorToken, ImportFontToken, ImportWarning } from './types'

/**
 * Accumulators threaded through every `parseCssSourceIntoPlan` call of one
 * `buildImportPlan` run. Maps dedupe across sources (first occurrence wins,
 * matching the source cascade order the caller iterates in).
 */
export interface CssPlanState {
  warnings: ImportWarning[]
  droppedAtRules: string[]
  /** Reusable conditions discovered across all CSS sources, deduped by id. */
  conditionsById: Map<string, ConditionDef>
  /** Colour tokens pulled from root-scope rules, deduped by slug. */
  colorsBySlug: Map<string, ImportColorToken>
  /** Font tokens pulled from root-scope rules, deduped by normalized variable. */
  fontTokensByVariable: Map<string, ImportFontToken>
  cssFileResults: CssFileResult[]
}

export function createCssPlanState(): CssPlanState {
  return {
    warnings: [],
    droppedAtRules: [],
    conditionsById: new Map(),
    colorsBySlug: new Map(),
    fontTokensByVariable: new Map(),
    cssFileResults: [],
  }
}

export interface ParseCssSourceOptions {
  breakpoints: Array<{ id: string; width: number; mediaQuery?: string }>
  mediaTolerance: number
  /** Harvests Google-font `@import` requests before they are stripped. */
  collectGoogleFonts: (cssSource: string) => void
}

/**
 * Parse one CSS source into the accumulated plan state.
 *
 * Colour-valued and font-stack root custom properties are pulled out of the
 * parsed rules so they become framework tokens instead of leftover `:root`
 * rules (which would double-emit each `--<slug>` alongside the framework's
 * own output).
 */
export function parseCssSourceIntoPlan(
  cssPath: string,
  cssSource: string,
  state: CssPlanState,
  options: ParseCssSourceOptions,
): void {
  options.collectGoogleFonts(cssSource)
  const cssForStyleRules = stripGoogleFontImportRules(cssSource)
  const { rules, warnings, assetRefs, conditions, fontFaces } = cssToStyleRules(cssForStyleRules, {
    breakpoints: options.breakpoints,
    mediaTolerance: options.mediaTolerance,
  })
  state.warnings.push(...warnings)
  for (const def of conditions) {
    if (!state.conditionsById.has(def.id)) state.conditionsById.set(def.id, def)
  }
  for (const w of warnings) {
    if (w.kind === 'dropped-at-rule' && w.source) state.droppedAtRules.push(w.source)
  }

  const { rules: rulesAfterColors, colorTokens } = extractRootColorTokens(rules)
  for (const token of colorTokens) {
    if (!state.colorsBySlug.has(token.slug)) state.colorsBySlug.set(token.slug, token)
  }
  const { rules: rulesAfterFontTokens, fontTokens } = extractRootFontTokens(rulesAfterColors)
  for (const token of fontTokens) {
    if (!state.fontTokensByVariable.has(token.variable)) state.fontTokensByVariable.set(token.variable, token)
  }

  state.cssFileResults.push({ cssPath, rules: rulesAfterFontTokens, assetRefs, fontFaces })
}
