import { isUserVisibleClass, styleRuleSelector } from '@core/page-tree'
import type { StyleRule, SiteDocument } from '@core/page-tree'

export function getReusableClasses(classes: Record<string, StyleRule>): StyleRule[] {
  return Object.values(classes).filter(isUserVisibleClass)
}

/**
 * Tally how many nodes reference each class, in a SINGLE pass over the whole
 * site tree. Returns a `Map<classId, count>`; classes with zero references are
 * simply absent (callers default to 0).
 *
 * This replaces a per-selector scan: counting one selector at a time was
 * O(selectors × pages × nodes), which made the Selectors panel janky to open
 * with hundreds of generated utility classes. One pass is O(pages × nodes)
 * regardless of how many selectors exist, and the React Compiler memoizes the
 * result against `site` so it only recomputes when the tree changes.
 */
export function buildSelectorUsageMap(site: SiteDocument | null): Map<string, number> {
  const usage = new Map<string, number>()
  if (!site) return usage

  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      const classIds = node.classIds
      if (!classIds) continue
      for (const classId of classIds) {
        usage.set(classId, (usage.get(classId) ?? 0) + 1)
      }
    }
  }
  return usage
}

export function formatSelectorUsage(count: number): string {
  if (count === 0) return 'Unused'
  return count === 1 ? 'Used 1 time' : `Used ${count} times`
}

/**
 * Map each class-kind rule's selector token (`.<escaped-name>`) to how many
 * nodes carry it, reusing the per-id tally from {@link buildSelectorUsageMap}.
 * `rule.selector` is already the escaped `.name` form the publisher emits, so
 * tokens here compare directly against tokens pulled out of an ambient
 * selector string — no re-escaping, no guesswork.
 */
export function buildClassTokenUsageMap(
  classes: Record<string, StyleRule>,
  usageById: Map<string, number>,
): Map<string, number> {
  const byToken = new Map<string, number>()
  for (const rule of Object.values(classes)) {
    if (rule.kind === 'ambient') continue
    byToken.set(rule.selector, usageById.get(rule.id) ?? 0)
  }
  return byToken
}

// `.foo`, `.nav-links`, `.hero-badge`, including CSS-escaped sequences (`\.`).
// Stops at `:` so `.hero-badge::before` and `.nav-links a:hover` yield only
// their class tokens, not the trailing pseudo.
const CLASS_TOKEN_RE = /\.(?:\\.|[\w-])+/g

/**
 * Is an ambient selector provably dead? Ambient rules attach by CSS matching,
 * not by `classIds`, so the per-id tally is always 0 for them — which is why
 * every ambient row used to read a misleading "Unused". We can't cheaply count
 * exact element matches, but we CAN prove a rule can never match: if it is
 * anchored on a class applied to zero nodes anywhere, no element it targets
 * exists. We only return true when EVERY comma-separated group is dead this
 * way. Tag / universal / pseudo-only selectors (`*`, `body`, `a:hover`) and
 * selectors anchored on a still-used class are never claimed unused — we show
 * no badge rather than assert something we can't prove.
 */
function isAmbientSelectorProvablyDead(
  cls: StyleRule,
  classTokenUsage: Map<string, number>,
): boolean {
  const groups = styleRuleSelector(cls)
    .split(',')
    .map((group) => group.trim())
    .filter(Boolean)
  if (groups.length === 0) return false

  for (const group of groups) {
    const tokens = group.match(CLASS_TOKEN_RE) ?? []
    // Only tokens the registry actually knows are evaluable; an unknown token
    // (escaping mismatch, attribute-value false positive) is treated as
    // possibly-live so we never claim a false "Unused".
    const knownCounts = tokens
      .map((token) => classTokenUsage.get(token))
      .filter((count): count is number => count !== undefined)
    // No anchor we can evaluate → can't disprove this group → not provably dead.
    if (knownCounts.length === 0) return false
    // A group matches only where ALL its classes are present; one anchor class
    // applied nowhere means this group can never match.
    if (!knownCounts.some((count) => count === 0)) return false
  }
  return true
}

interface SelectorUsage {
  /** Usage text, or `null` to render no badge (ambient rule we can't assess). */
  label: string | null
  /** Whether the rule counts as "unused" for the Unused filter. */
  unused: boolean
}

/**
 * Resolve the usage badge + filter state for a selector row. Class rules report
 * an exact reference count; ambient rules report "Unused" only when provably
 * dead (see {@link isAmbientSelectorProvablyDead}) and otherwise show nothing.
 */
export function resolveSelectorUsage(
  cls: StyleRule,
  usageById: Map<string, number>,
  classTokenUsage: Map<string, number>,
): SelectorUsage {
  if (cls.kind === 'ambient') {
    const dead = isAmbientSelectorProvablyDead(cls, classTokenUsage)
    return { label: dead ? 'Unused' : null, unused: dead }
  }
  const count = usageById.get(cls.id) ?? 0
  return { label: formatSelectorUsage(count), unused: count === 0 }
}

/**
 * Normalise a raw search query so the prop-aware matcher can compare it against
 * the tokens built from each rule. Lower-cases, trims, and collapses whitespace
 * around a colon so a user can type `font-size: 10px` (with or without the
 * space) and still match the `font-size:10px` token form. Also collapses runs
 * of internal whitespace to a single space.
 */
export function normalizeSelectorQuery(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
}

/**
 * Does this rule match the (already-normalised) query? Matches against BOTH the
 * selector name AND its declared CSS — every property name (`font-size`) and
 * `name:value` pair (`font-size:10px`), across base styles and every editing
 * context (breakpoints + custom conditions). This lets the Selectors panel
 * answer questions like "show me everything that sets `font-size`" or
 * "…that sets `font-size: 10px`", not just name lookups.
 */
export function selectorMatchesQuery(cls: StyleRule, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  if (cls.name.toLowerCase().includes(normalizedQuery)) return true
  if (styleRuleSelector(cls).toLowerCase().includes(normalizedQuery)) return true
  return buildSelectorSearchTokens(cls).some((token) => token.includes(normalizedQuery))
}

/**
 * Flatten a rule's CSS into searchable, normalised tokens: for every non-empty
 * declaration we emit the kebab-cased property name and a `name:value` pair, in
 * the same normalised form as {@link normalizeSelectorQuery}. Context overrides
 * (breakpoints + conditions) contribute their declarations too.
 */
function buildSelectorSearchTokens(cls: StyleRule): string[] {
  const tokens: string[] = []
  const collect = (styles: Record<string, unknown> | undefined) => {
    if (!styles) return
    for (const [key, value] of Object.entries(styles)) {
      if (!hasStyleValue(value)) continue
      const name = cssPropToKebab(key)
      tokens.push(name)
      tokens.push(`${name}:${String(value).toLowerCase().trim()}`)
    }
  }
  collect(cls.styles)
  for (const contextStyles of Object.values(cls.contextStyles ?? {})) {
    collect(contextStyles)
  }
  return tokens
}

/**
 * Convert a JS-style CSS property key (`fontSize`, `backgroundColor`) to its
 * authored kebab-case form (`font-size`, `background-color`) so search matches
 * what the user sees in CSS. Custom properties (`--foo`) and already-kebab keys
 * pass through unchanged.
 */
function cssPropToKebab(key: string): string {
  if (key.startsWith('--')) return key.toLowerCase()
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).toLowerCase()
}

export function getSelectorStyleSummary(cls: StyleRule): string {
  const propCount = Object.values(cls.styles).filter(hasStyleValue).length
  // contextStyles holds both viewport-context and custom-condition overrides
  // (the unified editing-context axis); count non-empty contexts.
  const contextCount = Object.values(cls.contextStyles ?? {}).filter((styles) =>
    Object.values(styles).some(hasStyleValue),
  ).length

  if (propCount === 0 && contextCount === 0) return 'No styles'
  if (contextCount === 0) return propCount === 1 ? '1 prop' : `${propCount} props`
  const propsLabel = propCount === 1 ? '1 prop' : `${propCount} props`
  const ctxLabel = contextCount === 1 ? '1 context' : `${contextCount} contexts`
  return `${propsLabel} · ${ctxLabel}`
}

function hasStyleValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}
