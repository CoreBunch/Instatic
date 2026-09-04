/**
 * StyleRule — a named CSS style rule that emits one rule into the stylesheet.
 *
 * A `StyleRule` can be any CSS rule, discriminated by `kind`:
 *
 *   - `kind: 'class'` — the rule is attached to nodes via `node.classIds`.
 *     User-created rules use `.<name>`; imported utility variants may retain
 *     a complex selector such as `.group:hover .group-hover\:block`, with
 *     `name` identifying the rightmost bindable class. The publisher emits
 *     that name into the node's class attribute and preserves the selector.
 *
 *   - `kind: 'ambient'` — the rule attaches by CSS matching, not by node
 *     assignment (e.g. `h1`, `h1 > span`, `a:hover`). The
 *     publisher emits the rule into the stylesheet only; nothing changes on
 *     node `class=` attributes. Used by the CSS importer and "Add ambient
 *     selector" affordance.
 *
 * Imported at-rules that cannot be represented as selector declarations, such
 * as `@keyframes`, store a sanitised `rawCss` block on an ambient rule. The
 * publisher only emits supported raw blocks after its own safety gate.
 *
 * §4.1 persistence note: `styles` and `contextStyles` are stored as
 * `Record<string, unknown>` matching `validate.ts` which stores the raw object
 * without narrowing to CSSPropertyBag. Narrowing happens at the publisher
 * boundary (`bagToCSS` in `classCss.ts`).
 *
 * CSSPropertyBag is used for the WRITE API (classSlice / framework
 * generators) which always writes only known CSS property keys.
 *
 * For tolerant parsing of persisted style rules (with per-entry fallbacks),
 * use `parseStyleRule` instead of `parseValue(StyleRuleSchema, raw)`.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static, withFallback } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'
import { GeneratedClassMetadataSchema } from '@core/framework-schema'
import {
  asPlainObject,
  parseBreakpointStylesBag,
  parseStringArrayField,
  parseStylesBag,
  parseTimestamp,
} from './parseHelpers'
import { escapeCssIdentifier as escapeCssIdent } from './cssIdentifier'

// ---------------------------------------------------------------------------
// StyleRuleSchema
// ---------------------------------------------------------------------------

const StyleRuleKindSchema = Type.Union([Type.Literal('class'), Type.Literal('ambient')])
export type StyleRuleKind = Static<typeof StyleRuleKindSchema>

/**
 * CSS declaration priority is deliberately stored beside — never inside — a
 * property value. Keeping the metadata sparse preserves the scalar
 * CSSPropertyBag values consumed by editor controls and node inline styles.
 */
export const CSSDeclarationPriorityBagSchema = Type.Record(
  Type.String(),
  Type.Literal('important'),
)
export type CSSDeclarationPriorityBag = Static<typeof CSSDeclarationPriorityBagSchema>

/**
 * Where an imported rule came from: the stylesheet it was parsed out of (a
 * FileMap key, or `<page>::inline` for a `<style>` block) and the rule's
 * ordinal within that sheet. A re-import matches incoming rules against this
 * — plus the selector — so the same rule arriving again replaces itself in
 * place instead of stacking a duplicate. Absent on user-authored rules.
 */
export const StyleRuleOriginSchema = Type.Object({
  source: Type.String(),
  ordinal: Type.Integer({ minimum: 0 }),
})

export type StyleRuleOrigin = Static<typeof StyleRuleOriginSchema>

export const StyleRuleSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** Discriminator for class-attached vs selector-attached rules. */
  kind: StyleRuleKindSchema,
  /**
   * The CSS selector expression emitted verbatim into the published
   * stylesheet:
   *   - kind:'class'   → contains the escaped `name` class token; imported
   *                      variants may include combinators, pseudo-classes, or
   *                      dependency classes around that binding token.
   *   - kind:'ambient' → any valid selector (`h1`, `h1 > span`, `.hero .title`,
   *                      `a:hover`, `[data-x="y"]`, ...).
   *
   */
  selector: Type.String(),
  /**
   * Cascade order — emitted rules are sorted ascending by `order`. Imported
   * rules preserve their position in the source stylesheet so author intent
   * survives. User-created rules append at the end.
   */
  order: Type.Number(),
  description: Type.Optional(Type.String()),
  /**
   * Optional ownership scope. If the scope object does not match the exact
   * shape, it is silently dropped — handled in parseStyleRule.
   */
  scope: Type.Optional(Type.Object({
    type: Type.Literal('node'),
    nodeId: Type.String(),
    role: Type.Literal('module-style'),
  })),
  /**
   * Base CSS styles — arbitrary string→unknown map at persistence boundary.
   * Falls back to {} when missing or invalid — handled in parseStyleRule.
   */
  styles: withFallback(Type.Record(Type.String(), Type.Unknown()), {} as Record<string, unknown>),
  /** Sparse property -> `important` metadata for base declarations. */
  stylePriorities: Type.Optional(CSSDeclarationPriorityBagSchema),
  /**
   * Per-context overrides — same persistence semantics as `styles`. The unified
   * "editing context" model (docs/plans/2026-05-30-unified-condition-axis.md):
   * one flat map keyed by a context id, where a context id is EITHER
   *   - a viewport context id (from `site.breakpoints`) → that context's
   *     configured `@media` query,
   *   - or a condition id (from `site.conditions`) → custom
   *     `@media` / `@container` / `@supports`.
   *
   * Falls back to {} when missing or invalid — handled in parseStyleRule.
   */
  contextStyles: withFallback(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
    {} as Record<string, Record<string, unknown>>,
  ),
  /** Sparse context id -> declaration-priority metadata. */
  contextStylePriorities: Type.Optional(Type.Record(Type.String(), CSSDeclarationPriorityBagSchema)),
  /** Sanitised raw CSS for supported stylesheet-level rules such as @keyframes. */
  rawCss: Type.Optional(Type.String()),
  /** Optional search/filter tags. Invalid items silently dropped — handled in parseStyleRule. */
  tags: Type.Optional(Type.Array(Type.String())),
  /** Metadata for framework-generated classes. Undefined if invalid — handled in parseStyleRule. */
  generated: Type.Optional(GeneratedClassMetadataSchema),
  /** Import provenance (see `StyleRuleOriginSchema`). Undefined if invalid — handled in parseStyleRule. */
  origin: Type.Optional(StyleRuleOriginSchema),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type StyleRule = Static<typeof StyleRuleSchema>

export type SelectorCreateInput =
  | { kind: 'class'; name: string }
  | { kind: 'ambient'; selector: string }
  | { kind: 'empty' }

const SINGLE_CLASS_INPUT_RE = /^\.?[a-zA-Z_-][a-zA-Z0-9_-]*$/

// Bare words are class-first. Heading tags are the common exception authors
// expect to behave as element selectors rather than new class names.
const HEADING_TAG_NAMES = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
])

/**
 * Build the canonical `.<escaped-name>` selector for a class-kind rule.
 * Used during class-rule creation and renames.
 */
export function classKindSelector(name: string): string {
  return `.${escapeCssIdent(name)}`
}

export function classifySelectorCreateInput(raw: string): SelectorCreateInput {
  const value = raw.trim()
  if (!value) return { kind: 'empty' }

  if (SINGLE_CLASS_INPUT_RE.test(value) && !HEADING_TAG_NAMES.has(value.toLowerCase())) {
    return { kind: 'class', name: value.startsWith('.') ? value.slice(1) : value }
  }

  return { kind: 'ambient', selector: value }
}

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

/** Parse the current `contextStyles` map for a rule. */
function parseContextStyles(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return parseBreakpointStylesBag(raw.contextStyles)
}

/** Keep only valid priority entries that still have a declaration value. */
function parsePriorityBag(
  raw: unknown,
  styles: Record<string, unknown>,
): CSSDeclarationPriorityBag | undefined {
  const record = asPlainObject(raw)
  if (!record) return undefined
  const priorities: CSSDeclarationPriorityBag = {}
  for (const [property, priority] of Object.entries(record)) {
    if (priority === 'important' && property in styles) priorities[property] = 'important'
  }
  return Object.keys(priorities).length > 0 ? priorities : undefined
}

function parseContextStylePriorities(
  raw: unknown,
  contextStyles: Record<string, Record<string, unknown>>,
): Record<string, CSSDeclarationPriorityBag> | undefined {
  const record = asPlainObject(raw)
  if (!record) return undefined
  const priorities: Record<string, CSSDeclarationPriorityBag> = {}
  for (const [contextId, contextPriorities] of Object.entries(record)) {
    const parsed = parsePriorityBag(contextPriorities, contextStyles[contextId] ?? {})
    if (parsed) priorities[contextId] = parsed
  }
  return Object.keys(priorities).length > 0 ? priorities : undefined
}

/** Parse a StyleRule scope (currently only `{ type: 'node', nodeId, role: 'module-style' }`). */
function parseStyleRuleScope(raw: unknown): StyleRule['scope'] {
  const s = asPlainObject(raw)
  if (!s) return undefined
  if (s.type !== 'node' || typeof s.nodeId !== 'string' || s.role !== 'module-style') return undefined
  return { type: 'node', nodeId: s.nodeId, role: 'module-style' }
}

/**
 * Parse a StyleRule, dropping entries that are missing the current selector
 * metadata and providing fallbacks only for resilient style-bag fields.
 */
export function parseStyleRule(raw: unknown): StyleRule | null {
  const r = asPlainObject(raw)
  if (!r) return null
  if (typeof r.id !== 'string') return null
  if (typeof r.name !== 'string') return null
  if (r.kind !== 'class' && r.kind !== 'ambient') return null
  if (typeof r.selector !== 'string' || r.selector.length === 0) return null
  if (typeof r.order !== 'number' || !Number.isFinite(r.order)) return null

  const scope = parseStyleRuleScope(r.scope)
  const tags = parseStringArrayField(r.tags)
  const styles = parseStylesBag(r.styles)
  const contextStyles = parseContextStyles(r)
  const stylePriorities = parsePriorityBag(r.stylePriorities, styles)
  const contextStylePriorities = parseContextStylePriorities(r.contextStylePriorities, contextStyles)
  const generated = compiledCheck(GeneratedClassMetadataSchema, r.generated)
    ? (r.generated as StyleRule['generated'])
    : undefined
  const origin = compiledCheck(StyleRuleOriginSchema, r.origin)
    ? (r.origin as StyleRuleOrigin)
    : undefined

  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    selector: r.selector,
    order: r.order,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(scope !== undefined ? { scope } : {}),
    styles,
    ...(stylePriorities !== undefined ? { stylePriorities } : {}),
    contextStyles,
    ...(contextStylePriorities !== undefined ? { contextStylePriorities } : {}),
    ...(typeof r.rawCss === 'string' && r.rawCss.trim() ? { rawCss: r.rawCss } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(generated !== undefined ? { generated } : {}),
    ...(origin !== undefined ? { origin } : {}),
    createdAt: parseTimestamp(r.createdAt),
    updatedAt: parseTimestamp(r.updatedAt),
  }
}

/** Parse the style rule registry: iterate entries and silently drop invalid current-shape rules. */
export function parseStyleRuleRegistry(raw: unknown): Record<string, StyleRule> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, StyleRule> = {}
  for (const [id, rule] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseStyleRule(rule)
    if (parsed) result[id] = parsed
  }
  return result
}
