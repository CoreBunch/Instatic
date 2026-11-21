/**
 * varRefs — rename custom properties across the imported CSS.
 *
 * When the importer moves a design token to a new name (a conflict rename, or
 * the framework's normalised colour slug), every `var(--old)` reference and
 * every `--old` declaration in the imported style rules, node inline styles
 * and raw `@keyframes` CSS must follow it, or the imported design stops
 * resolving to its own token.
 */

import type { NewStyleRule, PagePlan } from './types'

/**
 * Every custom property name (without `--`) the imported CSS declares: in style
 * rules (base and per-context) and in node inline styles.
 */
export function declaredCustomProperties(
  pages: PagePlan[],
  styleRules: NewStyleRule[],
): Set<string> {
  const names = new Set<string>()
  const collect = (bag: Record<string, unknown> | undefined) => {
    for (const key of Object.keys(bag ?? {})) {
      if (key.startsWith('--')) names.add(key.slice(2))
    }
  }
  for (const rule of styleRules) {
    collect(rule.styles)
    for (const bag of Object.values(rule.contextStyles ?? {})) collect(bag)
  }
  for (const page of pages) {
    for (const node of Object.values(page.nodeFragment.nodes)) collect(node.inlineStyles)
  }
  return names
}

/**
 * Rewrite `var(--old)` → `var(--new)` references inside a style rule's base
 * `styles` and every `contextStyles` bag. Returns the same rule when no value
 * changes.
 */
export function rewriteRuleVarRefs(rule: NewStyleRule, renames: Map<string, string>): NewStyleRule {
  const styles = rewriteStyleBagVarRefs(rule.styles, renames)
  const stylePriorities = rule.stylePriorities
    ? renameCustomPropertyKeys(rule.stylePriorities, renames)
    : rule.stylePriorities
  const rawCss = typeof rule.rawCss === 'string'
    ? renameCssDeclarations(rewriteCssVarRefs(rule.rawCss, renames), renames)
    : rule.rawCss
  const contextStyles = mapContextBags(rule.contextStyles, (bag) => rewriteStyleBagVarRefs(bag, renames))
  const contextStylePriorities = mapContextBags(
    rule.contextStylePriorities,
    (bag) => renameCustomPropertyKeys(bag, renames),
  )
  return styles === rule.styles
    && stylePriorities === rule.stylePriorities
    && contextStyles === rule.contextStyles
    && contextStylePriorities === rule.contextStylePriorities
    && rawCss === rule.rawCss
    ? rule
    : {
        ...rule,
        styles: styles as NewStyleRule['styles'],
        contextStyles: contextStyles as NewStyleRule['contextStyles'],
        ...(stylePriorities !== undefined ? { stylePriorities } : {}),
        ...(contextStylePriorities !== undefined ? { contextStylePriorities } : {}),
        ...(rawCss !== undefined ? { rawCss } : {}),
      }
}

/** Map every per-context bag; returns the same record when no bag changes. */
function mapContextBags<T extends Record<string, Record<string, unknown>>>(
  record: T | undefined,
  map: (bag: Record<string, unknown>) => Record<string, unknown>,
): T | undefined {
  if (!record || Object.keys(record).length === 0) return record
  let changed = false
  const out: Record<string, Record<string, unknown>> = {}
  for (const [ctxId, bag] of Object.entries(record)) {
    const next = map(bag)
    if (next !== bag) changed = true
    out[ctxId] = next
  }
  return changed ? (out as T) : record
}

/**
 * Rewrite `var(--old)` references in every string value of a style bag, and
 * rename a `--old` declaration itself, so an override in a non-root rule
 * (`.dark { --bg: #000 }`) keeps overriding the renamed token. Returns the
 * same object reference when nothing changes.
 */
export function rewriteStyleBagVarRefs<T extends Record<string, unknown>>(
  bag: T,
  renames: Map<string, string>,
): T {
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(bag)) {
    const nextKey = renameCustomPropertyKey(key, renames)
    if (nextKey !== key) changed = true
    if (typeof value === 'string') {
      const next = rewriteCssVarRefs(value, renames)
      if (next !== value) changed = true
      out[nextKey] = next
    } else {
      out[nextKey] = value
    }
  }
  return changed ? (out as T) : bag
}

/** Rename `--old` keys of a property-keyed bag (e.g. declaration priorities). */
function renameCustomPropertyKeys<T extends Record<string, unknown>>(
  bag: T,
  renames: Map<string, string>,
): T {
  if (!Object.keys(bag).some((key) => renameCustomPropertyKey(key, renames) !== key)) return bag
  return Object.fromEntries(
    Object.entries(bag).map(([key, value]) => [renameCustomPropertyKey(key, renames), value]),
  ) as T
}

function renameCustomPropertyKey(key: string, renames: Map<string, string>): string {
  if (!key.startsWith('--')) return key
  const next = renames.get(key.slice(2))
  return next ? `--${next}` : key
}

// Matches `var(--name` (optional leading whitespace), capturing the bare
// custom-property name. The fallback/closing-paren tail is left untouched.
const VAR_REF_RE = /var\(\s*--([A-Za-z0-9_-]+)/g

// Matches a `--name:` declaration in raw CSS text (e.g. `@keyframes` bodies),
// capturing what precedes it and the bare custom-property name.
const DECLARATION_RE = /(^|[{;\s])--([A-Za-z0-9_-]+)(?=\s*:)/g

/** Rename `--old:` declarations in raw CSS text for every name in `renames`. */
function renameCssDeclarations(css: string, renames: Map<string, string>): string {
  if (renames.size === 0 || !css.includes('--')) return css
  return css.replace(DECLARATION_RE, (match, before: string, name: string) => {
    const next = renames.get(name)
    return next ? `${before}--${next}` : match
  })
}

/** Rewrite `var(--old)` → `var(--new)` for every name in `renames`. */
function rewriteCssVarRefs(value: string, renames: Map<string, string>): string {
  if (renames.size === 0 || !value.includes('var(')) return value
  return value.replace(VAR_REF_RE, (match, name: string) => {
    const next = renames.get(name)
    return next ? match.replace(`--${name}`, `--${next}`) : match
  })
}
