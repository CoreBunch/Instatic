/**
 * Style rule registry helpers shared by every flow that merges foreign rules
 * into a site: HTML paste (`insertImportedNodes`), the whole-site import
 * (`mutateAllPagesAndSite`), and the fragment insert planner
 * (`@core/fragments`).
 *
 * Pure: operates on a plain `Record<string, StyleRule>` (or a Mutative draft of
 * one) and never touches editor state.
 */

import type { StyleRule } from './styleRule'

export type StyleRuleOrderAllocator = () => number

/**
 * Allocate monotonically increasing cascade positions for one merge
 * transaction. The existing registry is scanned once; every subsequent rule
 * append is O(1), even when a stylesheet contains tens of thousands of rules.
 */
export function createStyleRuleOrderAllocator(
  rules: Record<string, StyleRule>,
): StyleRuleOrderAllocator {
  let nextOrder = 0
  for (const rule of Object.values(rules)) {
    if (typeof rule.order === 'number' && rule.order >= nextOrder) {
      nextOrder = rule.order + 1
    }
  }
  return () => nextOrder++
}

/**
 * Index a StyleRule registry by name → id.
 * First id wins on duplicates (createClass enforces name uniqueness, so
 * duplicates only occur in corrupted data — first-wins is a defensive tiebreak).
 */
export function indexStyleRulesByName(rules: Record<string, StyleRule>): Map<string, string> {
  const byName = new Map<string, string>()
  for (const cls of Object.values(rules)) {
    if (!byName.has(cls.name)) byName.set(cls.name, cls.id)
  }
  return byName
}
