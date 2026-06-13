/**
 * cssToStyleRules — Phase 1 of the Super Import pipeline.
 *
 * Pure, headless CSS text → NewStyleRule[] parser. No UI, no zip handling,
 * no store integration. Just parse + classify + collect warnings + collect
 * asset refs.
 *
 * ## @media policy
 *
 * Matched @media (configured viewport query, or within ±mediaTolerance of a known max-width):
 *   inner declarations are folded into `contextStyles[matchedViewportId]`.
 *
 * Unmatched @media / every @container / every @supports:
 *   inner declarations are stored as a faithful per-context override keyed by a
 *   deterministic condition id (`contextStyles[<conditionId>]`), and the
 *   condition is recorded in the returned `conditions` registry. No "unmatched"
 *   folding into base styles, no lossy condition drop.
 *
 * ## asset-reference warnings
 *
 * The parser collects `url(...)` payloads into `assetRefs` but does NOT emit
 * `asset-reference` entries in `warnings`. The `asset-reference` warning kind
 * exists for Phase 2's use; Phase 1 just records URLs for later rewriting.
 *
 * ## order assignment
 *
 * `order` is assigned ascending from 0 in source position. The caller
 * (Phase 2's `applyImport.ts`) may re-order on merge. For a rule created by
 * a matched @media block (when no base rule existed), order reflects the
 * source position of the @media block.
 *
 * ## duplicate class names
 *
 * When the same `.class-name` selector appears more than once in the file,
 * the later rule wins (later-in-source = higher cascade priority). One
 * `duplicate-class` warning is emitted per duplicated class. The rule's
 * order is kept as the FIRST occurrence.
 */

import type { StyleRuleKind, Condition, ConditionDef } from '@core/page-tree'
import { conditionId, makeConditionDef } from '@core/page-tree'
import { formatVariant } from '@core/fonts'
import { processKeyframesRule } from './keyframesToStyleRule'
import { encodeSubstitutionDeclarations, readCssDeclarationBag } from '@core/css-substitution'
import { matchMediaQueryToViewport } from './mediaQueryMatch'
import type {
  ImportWarning,
  BreakpointHint,
  AssetRef,
  NewStyleRule,
  ParsedFontFace,
} from './types'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

interface CssToStyleRulesOptions {
  /**
   * Site viewport contexts used to match `@media` queries.
   * Defaults to `[]` (all @media queries are treated as unmatched).
   */
  breakpoints?: BreakpointHint[]
  /**
   * Tolerance in CSS pixels for matching an older/default max-width media query
   * to a viewport context by frame width. A query `(max-width: 768px)` matches a
   * context with width 775px if `mediaTolerance >= 7`. Defaults to 10.
   */
  mediaTolerance?: number
}

interface CssToStyleRulesResult {
  rules: NewStyleRule[]
  warnings: ImportWarning[]
  assetRefs: AssetRef[]
  /**
   * Reusable site-level conditions discovered in the source (custom @media /
   * @container / @supports). Each rule's overrides under one of these reference
   * it by id via `contextStyles[<conditionId>]`; the caller merges these into
   * `site.conditions`.
   */
  conditions: ConditionDef[]
  /**
   * `@font-face` blocks captured for import. The asset planner resolves each
   * `srcUrls` entry to a FileMap key + media upload, then `applyImport`
   * assembles a custom `FontEntry`. Raw url payloads here — not yet resolved.
   */
  fontFaces: ParsedFontFace[]
}

// ---------------------------------------------------------------------------
// CSSRule type constants (CSSOM spec §6.1 — rule.type numeric values)
//
// Using rule.type instead of instanceof so the code works in both the browser
// (native CSSStyleRule global) and the happy-dom test environment (constructors
// live on window, not globalThis).
// ---------------------------------------------------------------------------

const STYLE_RULE_TYPE = 1   // CSSStyleRule
const IMPORT_RULE_TYPE = 3  // CSSImportRule
const MEDIA_RULE_TYPE = 4   // CSSMediaRule
const FONT_FACE_RULE_TYPE = 5  // CSSFontFaceRule
const PAGE_RULE_TYPE = 6    // CSSPageRule
const KEYFRAMES_RULE_TYPE = 7  // CSSKeyframesRule
const KEYFRAME_RULE_TYPE = 8   // CSSKeyframeRule
const NAMESPACE_RULE_TYPE = 10 // CSSNamespaceRule
const SUPPORTS_RULE_TYPE = 12  // CSSSupportsRule

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a CSS source string for use in warning messages.
 * Appends `…` when the string is cut.
 */
function truncate(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

/**
 * A single `.class-name` selector with no compound selectors, no combinators,
 * and no pseudo-classes/elements.
 *
 * Matches: `.foo`, `.btn-primary`, `.my_class`
 * Doesn't match: `.foo.bar`, `.foo .bar`, `h1`, `a:hover`, `[data-x]`, `.foo::after`
 */
const SINGLE_CLASS_RE = /^\.[a-zA-Z_][\w-]*$/

function classifySelector(selector: string): { kind: StyleRuleKind; name: string } {
  if (SINGLE_CLASS_RE.test(selector)) {
    // kind:'class' — selector is `.<name>`, name is the part after the dot
    return { kind: 'class', name: selector.slice(1) }
  }
  // kind:'ambient' — the selector text IS the display name
  return { kind: 'ambient', name: selector }
}

/**
 * Get the CSSStyleSheet constructor, falling back to the happy-dom window
 * object in test environments where the constructor is not on globalThis.
 */
function getSheetConstructor(): typeof CSSStyleSheet | null {
  if (typeof CSSStyleSheet !== 'undefined') return CSSStyleSheet
  // happy-dom test env: available on globalThis.window
  const w =
    typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)
      : null
  if (w?.CSSStyleSheet) return w.CSSStyleSheet as typeof CSSStyleSheet
  return null
}

/**
 * Read all `url(...)` payloads from a CSS declaration value.
 * Handles single-quoted, double-quoted, and unquoted forms.
 * Handles multiple urls per value (e.g. `background: url(a) url(b)`).
 */
function extractUrlPayloads(value: string): string[] {
  const result: string[] = []
  // Captures: group 1 = optional quote char, group 2 = url content (excl. quotes/parens)
  const re = /url\(\s*(['"]?)([^'")\n]*)\1\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const rawUrl = m[2].trim()
    if (rawUrl) result.push(rawUrl)
  }
  return result
}

/**
 * Parse all declarations from a CSSStyleDeclaration into a camelCase Record.
 *
 * Phase 1a: the property gate is permissive — `isEmittableProperty` accepts
 * any valid CSS property name except a tiny denylist. So a real-site import
 * keeps every standard property (`flex-grow`, `grid-auto-flow`, …) instead of
 * dropping it. The only declarations dropped here are the genuinely
 * dead/dangerous denied names, surfaced as a (rare) `blocked-property`
 * warning rather than the old flood of `unknown-property`.
 *
 * The brief specifies using `.length` + index access (not `for...of`) since
 * CSSStyleDeclaration doesn't enumerate properties via Symbol.iterator.
 */
function parseDeclarations(
  style: CSSStyleDeclaration,
  selectorForWarning: string,
  warnings: ImportWarning[],
): Record<string, unknown> {
  return readCssDeclarationBag(style, (camel, kebab) => {
    warnings.push({
      kind: 'blocked-property',
      message: `Property "${camel}" (${kebab}) is blocked for security and was dropped`,
      selector: selectorForWarning,
      property: camel,
    })
  })
}

/**
 * Scan a declarations map for `url(...)` values and append AssetRef entries.
 */
function collectAssetRefsFromDecls(
  decls: Record<string, unknown>,
  ruleIndex: number,
  contextId: string | undefined,
  assetRefs: AssetRef[],
  rawCss = false,
): void {
  for (const [property, value] of Object.entries(decls)) {
    if (typeof value !== 'string') continue
    for (const rawUrl of extractUrlPayloads(value)) {
      assetRefs.push({
        ruleIndex,
        ...(contextId !== undefined ? { contextId } : {}),
        ...(rawCss ? { rawCss: true } : {}),
        property,
        rawUrl,
      })
    }
  }
}

/**
 * Human-readable @-rule name from the CSSOM `rule.type` integer.
 */
function atRuleName(type: number): string {
  switch (type) {
    case IMPORT_RULE_TYPE:   return '@import'
    case FONT_FACE_RULE_TYPE: return '@font-face'
    case PAGE_RULE_TYPE:     return '@page'
    case KEYFRAMES_RULE_TYPE: return '@keyframes'
    case KEYFRAME_RULE_TYPE:  return '@keyframe'
    case NAMESPACE_RULE_TYPE: return '@namespace'
    case SUPPORTS_RULE_TYPE: return '@supports'
    default:                 return `CSS at-rule (type ${type})`
  }
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Parse a CSS text string into an array of `NewStyleRule` objects.
 *
 * Uses the browser-native `CSSStyleSheet.replaceSync()` API (available in
 * modern browsers and happy-dom). If that throws (sheet-level parse error),
 * returns a single `invalid-rule` warning and no rules.
 *
 * @param cssText - Raw CSS source text.
 * @param options - Optional breakpoints + tolerance for @media matching.
 * @returns Parsed rules, warnings, and URL asset references.
 */
export function cssToStyleRules(
  cssText: string,
  options?: CssToStyleRulesOptions,
): CssToStyleRulesResult {
  const breakpoints = options?.breakpoints ?? []
  const mediaTolerance = options?.mediaTolerance ?? 10

  const rules: NewStyleRule[] = []
  const warnings: ImportWarning[] = []
  const assetRefs: AssetRef[] = []
  const fontFaces: ParsedFontFace[] = []
  // Reusable conditions discovered in the source, deduped by id.
  const conditionsById = new Map<string, ConditionDef>()

  // ── Acquire the CSS engine ──────────────────────────────────────────────
  const SheetCtor = getSheetConstructor()
  if (!SheetCtor) {
    warnings.push({
      kind: 'invalid-rule',
      message: 'CSSStyleSheet is not available in this environment',
      source: truncate(cssText),
    })
    return { rules, warnings, assetRefs, conditions: [], fontFaces }
  }

  // ── Sheet-level parse ───────────────────────────────────────────────────
  let sheet: CSSStyleSheet
  try {
    sheet = new SheetCtor()
    // Substitution declarations (`var()`/`env()`) are encoded as marker
    // custom properties first — every engine preserves custom properties
    // verbatim, where shorthand-with-var handling is lossy and
    // engine-divergent. `parseDeclarations` decodes them back.
    sheet.replaceSync(encodeSubstitutionDeclarations(cssText))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push({
      kind: 'invalid-rule',
      message: `CSS parse error: ${message}`,
      source: truncate(cssText),
    })
    return { rules, warnings, assetRefs, conditions: [], fontFaces }
  }

  // ── Rule-processing state ───────────────────────────────────────────────
  //
  // selectorToLastIndex: tracks the most-recently-created rule index for each
  //   selector. Used when @media inner rules need to look up or create a rule.
  //
  // seenClassSelectors: tracks class selectors seen in base rules so we can
  //   emit a duplicate-class warning on the second occurrence.
  const selectorToLastIndex = new Map<string, number>()
  const seenClassSelectors = new Set<string>()

  // ── Process each top-level rule ─────────────────────────────────────────
  for (let i = 0; i < sheet.cssRules.length; i++) {
    const rule = sheet.cssRules[i]
    try {
      processTopLevelRule(
        rule,
        rules,
        warnings,
        assetRefs,
        fontFaces,
        conditionsById,
        breakpoints,
        mediaTolerance,
        selectorToLastIndex,
        seenClassSelectors,
      )
    } catch (_err) {
      // Per-rule resilience: if a rule throws unexpectedly, warn and continue.
      warnings.push({
        kind: 'invalid-rule',
        message: `Unexpected error processing rule: ${_err instanceof Error ? _err.message : String(_err)}`,
        source: truncate(rule.cssText),
      })
    }
  }

  return { rules, warnings, assetRefs, conditions: [...conditionsById.values()], fontFaces }
}

// ---------------------------------------------------------------------------
// Top-level rule processing
// ---------------------------------------------------------------------------

function processTopLevelRule(
  rule: CSSRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  fontFaces: ParsedFontFace[],
  conditionsById: Map<string, ConditionDef>,
  breakpoints: BreakpointHint[],
  mediaTolerance: number,
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
): void {
  switch (rule.type) {
    case STYLE_RULE_TYPE:
      processBaseStyleRule(
        rule as CSSStyleRule,
        rules,
        warnings,
        assetRefs,
        selectorToLastIndex,
        seenClassSelectors,
      )
      return

    case MEDIA_RULE_TYPE:
      processMediaRule(
        rule as CSSMediaRule,
        rules,
        warnings,
        assetRefs,
        conditionsById,
        breakpoints,
        mediaTolerance,
        selectorToLastIndex,
        seenClassSelectors,
      )
      return

    case SUPPORTS_RULE_TYPE: {
      // @supports (feature query) → custom-condition override, stored verbatim.
      const supportsRule = rule as CSSConditionRule
      const query = supportsRule.conditionText ?? ''
      processConditionInner(
        supportsRule,
        rules,
        warnings,
        assetRefs,
        conditionsById,
        selectorToLastIndex,
        seenClassSelectors,
        { kind: 'supports', query },
      )
      return
    }

    case FONT_FACE_RULE_TYPE:
      // @font-face isn't a StyleRule (no selector — it's a stylesheet-level
      // declarative side-effect), so it's captured into `fontFaces` instead.
      // We still scrape its `src: url(...)` as assetRefs so the binaries upload
      // to the media library; `applyImport` then assembles a custom FontEntry
      // from the captured face + uploaded files. No `dropped-at-rule` warning —
      // self-hosted faces are imported, not dropped. Faces whose every src is
      // external surface an `external-font` warning later (in applyImport).
      collectFontFace(rule as CSSFontFaceRule, assetRefs, rules.length, fontFaces)
      return

    case KEYFRAMES_RULE_TYPE:
      // Keyframes are stylesheet-level definitions that selector rules refer to
      // by `animation-name`. They must publish globally or animation-start
      // states like `opacity: 0` never resolve to their final frame.
      processKeyframesRule(rule as CSSKeyframesRule, rules, warnings, assetRefs, {
        parseDeclarations,
        collectAssetRefsFromDecls,
      })
      return

    default: {
      // @container has no stable legacy `rule.type` (it's a newer CSSOM
      // addition; browsers report 0). Detect it structurally: a grouping rule
      // whose cssText starts with `@container`. Route it to a conditional
      // layer keyed on the verbatim query (+ optional container name).
      const groupingRule = rule as Partial<CSSGroupingRule> & { cssText?: string; containerName?: string; containerQuery?: string }
      const cssText = groupingRule.cssText ?? ''
      // A grouping rule (it exposes `cssRules`) whose cssText starts with
      // `@container`. cssRules is a CSSRuleList, not an Array, so test for its
      // presence rather than Array.isArray.
      if (/^@container\b/i.test(cssText) && (groupingRule as CSSGroupingRule).cssRules) {
        const containerMatch = cssText.match(/^@container\s+([^({]+?)?\s*\(([^)]*)\)/i)
        if (containerMatch) {
          const name = (groupingRule.containerName || containerMatch[1] || '').trim()
          const query = (groupingRule.containerQuery || containerMatch[2] || '').trim()
          processConditionInner(
            groupingRule as CSSGroupingRule,
            rules,
            warnings,
            assetRefs,
            conditionsById,
            selectorToLastIndex,
            seenClassSelectors,
            { kind: 'container', query, ...(name ? { name } : {}) },
          )
          return
        }
      }

      // Genuinely unsupported at-rules: @import, @page, @namespace, @layer,
      // and anything else. (@import is usually silently
      // dropped by replaceSync; this handles the rare surfaced case.)
      warnings.push({
        kind: 'dropped-at-rule',
        message: `${atRuleName(rule.type)} rule is not supported by the import engine`,
        source: truncate(rule.cssText),
      })
      return
    }
  }
}

/**
 * Strip surrounding quotes from a parsed `font-family` descriptor value.
 * `"Acme Sans"` → `Acme Sans`; `Acme Sans` → `Acme Sans`.
 */
function unquoteFamily(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Map an `@font-face` `font-weight` + `font-style` descriptor pair to a
 * canonical variant tag ("400", "700italic", …).
 *
 * `font-weight` may be a keyword (`normal`/`bold`), a number, or a variable-font
 * range (`100 900`) — we take the first numeric token, defaulting to 400.
 * `font-style` counts as italic when it's `italic` or `oblique`.
 */
function fontFaceVariant(decl: CSSStyleDeclaration): string {
  const weightRaw = (decl.getPropertyValue('font-weight') || '').trim().toLowerCase()
  const styleRaw = (decl.getPropertyValue('font-style') || '').trim().toLowerCase()

  let weight = 400
  if (weightRaw === 'bold') weight = 700
  else if (weightRaw === 'normal' || weightRaw === '') weight = 400
  else {
    const firstNumber = weightRaw.match(/\d{2,3}/)
    if (firstNumber) weight = Number(firstNumber[0])
  }

  const italic = styleRaw.startsWith('italic') || styleRaw.startsWith('oblique')
  return formatVariant({ weight, italic })
}

/**
 * Capture one `@font-face` block:
 *   - record every `src: url(...)` payload as an assetRef so the binaries
 *     upload to the media library (synthetic ruleIndex, same as before), and
 *   - push a `ParsedFontFace` (family + variant + raw urls + unicode-range)
 *     so `applyImport` can assemble a custom FontEntry once URLs are rewritten.
 *
 * A face with no `font-family` or no `url()` src (e.g. `local(...)`-only) is
 * skipped — there's nothing self-hostable to import.
 */
function collectFontFace(
  rule: CSSFontFaceRule,
  assetRefs: AssetRef[],
  syntheticRuleIndex: number,
  fontFaces: ParsedFontFace[],
): void {
  const decl = rule.style
  if (!decl) return
  const srcValue = decl.getPropertyValue('src')
  if (!srcValue) return

  // Upload every referenced binary (existing behavior) so even an unmodellable
  // face leaves its files in the media library.
  collectAssetRefsFromDecls(
    { src: srcValue } as unknown as Record<string, string>,
    syntheticRuleIndex,
    undefined,
    assetRefs,
  )

  const family = unquoteFamily(decl.getPropertyValue('font-family') || '')
  const srcUrls = extractUrlPayloads(srcValue)
  if (!family || srcUrls.length === 0) return

  const unicodeRange = (decl.getPropertyValue('unicode-range') || '').trim()
  fontFaces.push({
    family,
    variant: fontFaceVariant(decl),
    srcUrls,
    ...(unicodeRange ? { unicodeRange } : {}),
  })
}

// ---------------------------------------------------------------------------
// Base CSSStyleRule processing
// ---------------------------------------------------------------------------

function processBaseStyleRule(
  rule: CSSStyleRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
): void {
  const selector = rule.selectorText.trim()
  const classified = classifySelector(selector)
  const decls = parseDeclarations(rule.style, selector, warnings)

  if (classified.kind === 'class') {
    if (seenClassSelectors.has(selector)) {
      // Duplicate class: later-in-source wins. Update existing rule's styles.
      warnings.push({
        kind: 'duplicate-class',
        message: `Class "${classified.name}" (${selector}) appears more than once; later declaration wins`,
        selector,
      })
      const existingIdx = selectorToLastIndex.get(selector)!
      // Overwrite base styles with the new declarations (last-write-wins)
      Object.assign(rules[existingIdx].styles, decls)
      // Collect any new asset refs from the updated declarations
      collectAssetRefsFromDecls(decls, existingIdx, undefined, assetRefs)
      return
    }
    seenClassSelectors.add(selector)
  }

  const idx = rules.length
  rules.push({
    name: classified.name,
    kind: classified.kind,
    selector,
    order: idx,
    styles: decls,
    contextStyles: {},
  })
  selectorToLastIndex.set(selector, idx)
  collectAssetRefsFromDecls(decls, idx, undefined, assetRefs)
}

// ---------------------------------------------------------------------------
// @media rule processing
// ---------------------------------------------------------------------------

function processMediaRule(
  mediaRule: CSSMediaRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  conditionsById: Map<string, ConditionDef>,
  breakpoints: BreakpointHint[],
  mediaTolerance: number,
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
): void {
  // conditionText is on CSSConditionRule (parent of CSSMediaRule) per CSSOM spec.
  // Fallback to mediaText for environments that don't expose conditionText.
  const conditionText =
    (mediaRule as CSSMediaRule & { conditionText?: string }).conditionText
    ?? mediaRule.media.mediaText

  const matched = matchMediaQueryToViewport(conditionText, breakpoints, mediaTolerance)

  if (matched !== null) {
    // Matched breakpoint: merge inner rules into contextStyles[matched.id].
    processConditionInner(
      mediaRule,
      rules,
      warnings,
      assetRefs,
      conditionsById,
      selectorToLastIndex,
      seenClassSelectors,
      { kind: 'breakpoint', breakpointId: matched.id },
    )
  } else {
    // Unmatched @media: store the inner declarations as a faithful per-context
    // override keyed on the verbatim media query — NOT folded into base styles
    // (which was lossy: it dropped the condition and let the override leak to
    // all viewports). The query round-trips and re-emits as `@media <query>`.
    processConditionInner(
      mediaRule,
      rules,
      warnings,
      assetRefs,
      conditionsById,
      selectorToLastIndex,
      seenClassSelectors,
      { kind: 'media', query: conditionText },
    )
  }
}

/**
 * Process the inner CSSStyleRules of a conditional @-block (@media /
 * @container / @supports), writing each inner rule's declarations to one
 * editing context on the matching StyleRule. Both kinds land in the unified
 * `contextStyles` map:
 *   - `{ kind: 'breakpoint', breakpointId }` → `contextStyles[breakpointId]`.
 *   - any custom condition → `contextStyles[conditionId(condition)]`, and the
 *     condition is registered in `conditionsById` (the reusable registry).
 */
type ConditionTarget =
  | { kind: 'breakpoint'; breakpointId: string }
  | Condition

/** Resolve the `contextStyles` key for a target. */
function targetContextId(target: ConditionTarget): string {
  return target.kind === 'breakpoint' ? target.breakpointId : conditionId(target)
}

function processConditionInner(
  block: CSSGroupingRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  conditionsById: Map<string, ConditionDef>,
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
  target: ConditionTarget,
): void {
  const contextId = targetContextId(target)
  // Register the reusable condition definition for custom conditions.
  if (target.kind !== 'breakpoint' && !conditionsById.has(contextId)) {
    conditionsById.set(contextId, makeConditionDef(target))
  }

  for (let i = 0; i < block.cssRules.length; i++) {
    const inner = block.cssRules[i]
    // Only process style rules inside the @-block (skip nested @-rules)
    if (inner.type !== STYLE_RULE_TYPE) continue

    const innerStyle = inner as CSSStyleRule
    const selector = innerStyle.selectorText.trim()
    const decls = parseDeclarations(innerStyle.style, selector, warnings)

    // Find or create the rule for this selector
    let idx: number
    if (selectorToLastIndex.has(selector)) {
      idx = selectorToLastIndex.get(selector)!
    } else {
      const classified = classifySelector(selector)
      idx = rules.length
      rules.push({
        name: classified.name,
        kind: classified.kind,
        selector,
        order: idx,
        styles: {},
        contextStyles: {},
      })
      selectorToLastIndex.set(selector, idx)
      if (classified.kind === 'class') seenClassSelectors.add(selector)
    }

    const existing = (rules[idx].contextStyles[contextId] ?? {}) as Record<string, unknown>
    rules[idx].contextStyles[contextId] = { ...existing, ...decls }
    collectAssetRefsFromDecls(decls, idx, contextId, assetRefs)
  }
}
