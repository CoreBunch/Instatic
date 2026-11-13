/**
 * Per-render node visibility — the mutation side.
 *
 * The shape and its evaluator live elsewhere: `VisibilityCondition` in
 * `./dynamicBinding` (beside the binding sources it reuses), and `isNodeVisible`
 * in `@core/templates/dynamicBindings` (beside the render context it reads).
 * This module holds only the write.
 *
 * Its own file rather than `./mutations` because that module is capped
 * grandfathered debt — the size gate says it may shrink, never grow, and
 * extracting is exactly what the gate asks for.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'
import type { VisibilityCondition } from './dynamicBinding'

/**
 * Set or clear the node's visibility condition.
 *
 * `undefined` clears it, which is not the same as a condition that happens to
 * evaluate false: a node with no condition is always visible, and that is the
 * state it returns to when the author removes the rule.
 */
export function setNodeVisibleWhen(
  tree: NodeTree<PageNode>,
  nodeId: string,
  condition: VisibilityCondition | undefined,
): void {
  const node = tree.nodes[nodeId]
  if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
  if (condition) node.visibleWhen = condition
  else delete node.visibleWhen
}
