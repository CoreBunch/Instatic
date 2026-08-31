/**
 * Root-scope selector helpers shared by import token extractors.
 */

import type { NewStyleRule } from './types'

/** Selectors whose custom properties define document-wide tokens. */
const ROOT_SCOPE_SELECTORS = new Set([':root', 'html', 'body'])

/**
 * A selector that targets only the document root: `:root`, `html`, `body`, or a
 * comma group of those. Compound/qualified selectors (`:root.theme-alt`) are
 * not root scope and keep their vars.
 */
export function isRootScopeSelector(selector: string): boolean {
  const parts = selector.split(',').map((p) => p.trim().toLowerCase())
  return parts.length > 0 && parts.every((p) => ROOT_SCOPE_SELECTORS.has(p))
}

/**
 * Lift custom properties out of every root-scope ambient rule.
 *
 * `pick` decides what counts as a token for a given declaration and returns the
 * token to extract, or null to leave the declaration on the rule. `!important`
 * declarations are never extracted — they are load-bearing overrides.
 *
 * Returns the rewritten rule list (extracted properties removed, emptied rules
 * dropped) and the tokens in source order. Every non-root rule passes through
 * unchanged.
 */
export function extractRootCustomProperties<T>(
  rules: NewStyleRule[],
  pick: (prop: string, value: string) => T | null,
): { rules: NewStyleRule[]; tokens: T[] } {
  const tokens: T[] = []
  const out: NewStyleRule[] = []

  for (const rule of rules) {
    if (rule.kind !== 'ambient' || !isRootScopeSelector(rule.selector)) {
      out.push(rule)
      continue
    }

    const remaining: Record<string, unknown> = {}
    const remainingPriorities: Record<string, 'important'> = {}
    for (const [prop, value] of Object.entries(rule.styles)) {
      const important = rule.stylePriorities?.[prop] === 'important'
      const token = !important && typeof value === 'string' ? pick(prop, value) : null
      if (token) {
        tokens.push(token)
      } else {
        remaining[prop] = value
        if (important) remainingPriorities[prop] = 'important'
      }
    }

    const hasContext = Object.keys(rule.contextStyles ?? {}).length > 0
    // Keep the rule only if it still carries declarations (base or contextual).
    if (Object.keys(remaining).length > 0 || hasContext) {
      const rewritten = { ...rule, styles: remaining }
      if (Object.keys(remainingPriorities).length > 0) {
        rewritten.stylePriorities = remainingPriorities
      } else {
        delete rewritten.stylePriorities
      }
      out.push(rewritten)
    }
  }

  return { rules: out, tokens }
}
