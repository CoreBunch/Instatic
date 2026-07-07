/**
 * styleRule slice — pure, side-effect-free helpers shared by the action
 * factories. Each is a plain function over its arguments; none touch the store
 * directly (callers pass in the live draft / registry).
 */

import type { Draft } from 'mutative'
import type { EditorStore } from '@site/store/types'
import type { BaseNode, SiteDocument } from '@core/page-tree'
import type { StyleRule, CSSPropertyBag } from '@core/page-tree'

/**
 * Compute the next cascade `order` value for a newly-inserted style rule:
 * always >= every existing order so the new rule appends at the end of the
 * cascade. Imported CSS uses explicit `order` values from the source; this
 * helper is only for user-initiated creation through the slice.
 */
export function nextRuleOrder(classes: Record<string, StyleRule>): number {
  let max = -1
  for (const cls of Object.values(classes)) {
    if (typeof cls.order === 'number' && cls.order > max) max = cls.order
  }
  return max + 1
}

export function hasStylePatchChanges(
  current: Record<string, unknown>,
  patch: Partial<CSSPropertyBag>,
): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      if (key in current) return true
    } else if (!Object.is(current[key], value)) {
      return true
    }
  }
  return false
}

export function shallowEqualStyles(
  a: Partial<CSSPropertyBag>,
  b: Partial<CSSPropertyBag>,
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

export function cloneContextStyles(
  contextStyles: StyleRule['contextStyles'],
): StyleRule['contextStyles'] {
  return Object.fromEntries(
    Object.entries(contextStyles).map(([contextId, styles]) => [
      contextId,
      { ...styles },
    ]),
  )
}

/**
 * Find a node by id anywhere in the site — pages **and** Visual Component
 * trees. Returns null when the node doesn't exist anywhere.
 *
 * Node↔class mutations need this because the user can be editing either a
 * page or a VC; the canvas selection lives in whichever document is active.
 * Searching only `site.pages` (the original implementation) silently
 * no-ops every class assignment when the user is in VC canvas mode.
 *
 * VCNode = BaseNode (structurally identical), so a single `BaseNode`-shaped
 * helper covers both tree kinds.
 */
export function findNodeWithClassIds(
  site: SiteDocument | null,
  nodeId: string,
): BaseNode | null {
  if (!site) return null
  for (const page of site.pages) {
    const node = page.nodes[nodeId]
    if (node) return node
  }
  for (const vc of site.visualComponents) {
    const node = vc.tree.nodes[nodeId]
    if (node) return node
  }
  return null
}

/**
 * Apply a mutation to a node's `classIds` array inside a Mutative recipe,
 * looking up the node in pages first and falling back to Visual Component
 * trees. The recipe receives the live (draft) `classIds` array — mutate it
 * in place. Initialises `classIds` to `[]` when missing.
 *
 * Returns `true` when the node was found and the recipe ran, `false`
 * otherwise (used by callers to skip post-mutation bookkeeping when the
 * node has been removed concurrently).
 */
export function mutateNodeClassIds(
  state: Draft<EditorStore>,
  nodeId: string,
  recipe: (classIds: string[]) => void,
): boolean {
  if (!state.site) return false
  for (const page of state.site.pages) {
    const node = page.nodes[nodeId]
    if (node) {
      if (!node.classIds) node.classIds = []
      recipe(node.classIds)
      return true
    }
  }
  for (const vc of state.site.visualComponents) {
    const node = vc.tree.nodes[nodeId]
    if (node) {
      if (!node.classIds) node.classIds = []
      recipe(node.classIds)
      return true
    }
  }
  return false
}

export function uniqueClassCopyName(classes: Record<string, StyleRule>, originalName: string): string {
  const existingNames = new Set(Object.values(classes).map((cls) => cls.name))
  const baseName = `${originalName}-copy`
  if (!existingNames.has(baseName)) return baseName

  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`)) {
    suffix += 1
  }
  return `${baseName}-${suffix}`
}
