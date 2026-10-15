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
import type { AssetRef, ImportColorToken, ImportFontToken, ImportWarning, NewStyleRule } from './types'
import { dirname } from './paths'

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

/**
 * Drop the rules of one page's inline source that an earlier page's inline
 * source already contributed byte-for-byte.
 *
 * CMS themes print customizer CSS, block-support CSS and similar site-wide
 * blocks into every page's head. Each page's `<style>` CSS is parsed as its
 * own source, so a site-wide block became one copy of every rule per page,
 * interleaved through the global sheet in page order. Each copy is harmless on
 * its own, but together they outrank any single page's override of the same
 * element at equal specificity: when one page sets `.menu a { color:#1e1e1e }`
 * after the site-wide `.nav a { color:#fff }`, every later page's copy of the
 * white rule comes after it in the flattened sheet, so that page's link
 * renders white. A browser sees one copy per page, and the page's own override
 * last. Keeping the first copy and dropping the rest gives the flattened
 * sheet the same shape.
 *
 * Only inline page sources are compared, and only against earlier inline
 * sources: a linked sheet that repeats a rule is left alone, and a page that
 * repeats its own rule keeps both, because the cascade inside one source is
 * the author's. A rule that references assets by relative url() is keyed with
 * its page directory, so two pages in different directories that print the
 * same `url(../x.png)` stay distinct. Surviving rules are renumbered and their
 * asset refs re-pointed so indices still line up.
 */
export function dedupeRepeatedInlineRules(
  file: CssFileResult,
  seenRuleKeys: Set<string>,
): CssFileResult {
  const refsByRule = new Map<number, AssetRef[]>()
  for (const ref of file.assetRefs) {
    const bucket = refsByRule.get(ref.ruleIndex) ?? []
    bucket.push(ref)
    refsByRule.set(ref.ruleIndex, bucket)
  }
  const directory = dirname(file.cssPath)
  const keysThisSource: string[] = []
  const kept: NewStyleRule[] = []
  const keptRefs: AssetRef[] = []
  let changed = false
  file.rules.forEach((rule, index) => {
    const { order: _order, ...identity } = rule
    const scope = refsByRule.has(index) ? directory : ''
    const key = `${scope}\u0000${JSON.stringify(identity)}`
    keysThisSource.push(key)
    if (seenRuleKeys.has(key)) {
      changed = true
      return
    }
    const newIndex = kept.length
    kept.push(newIndex === index ? rule : { ...rule, order: newIndex })
    for (const ref of refsByRule.get(index) ?? []) {
      keptRefs.push(ref.ruleIndex === newIndex ? ref : { ...ref, ruleIndex: newIndex })
    }
  })
  for (const key of keysThisSource) seenRuleKeys.add(key)
  if (!changed) return file
  return { ...file, rules: kept, assetRefs: keptRefs }
}
