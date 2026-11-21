/**
 * Cascade order allocation shared by every flow that merges foreign rules into
 * a site: HTML paste (`insertImportedNodes`), the whole-site import
 * (`mutateAllPagesAndSite`), and the fragment insert planner
 * (`@core/fragments`).
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
