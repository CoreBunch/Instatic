import type { BaseNode } from './baseNode'
import { collectSubtreeIds } from './selectors'

/**
 * Remove a node and its entire subtree from a flat node map, in place.
 *
 * This is THE single subtree-deletion primitive. Every deletion path routes
 * through it:
 *   - `deleteNode` (page-tree mutations) — `unlinkParent: true`
 *   - `removeNodeSubtrees` (cascade VC-ref removal) — `unlinkParent: true`
 *   - slot-sync's delete op (visualComponents/slotSync) — `unlinkParent: false`
 *
 * The subtree is collected via the cycle-safe `collectSubtreeIds` walker, so a
 * corrupt tree containing a cycle terminates instead of looping forever.
 *
 * Parent unlink ALWAYS uses the O(1) `parentId` cache — never an O(N)
 * `Object.values` scan. `parentId` is a derived cache of the `children` arrays,
 * maintained by every mutation and restamped at every load/parse boundary, so
 * it is reliably populated for any tree that has entered the system.
 *
 * `unlinkParent` controls whether the root is spliced out of its parent's
 * `children[]`. Slot-sync passes `false` because it overwrites the VC ref's
 * `children` array wholesale afterwards (the parent fix is the caller's job).
 *
 * Safe to call inside a Mutative recipe (the in-place splice/delete operate
 * on the draft) or on a plain object map.
 */
export function deleteSubtree(
  nodes: Record<string, BaseNode>,
  rootId: string,
  options: { unlinkParent?: boolean } = {},
): void {
  const { unlinkParent = true } = options
  const root = nodes[rootId]
  if (!root) return

  if (unlinkParent) {
    const parent = root.parentId ? nodes[root.parentId] : undefined
    if (parent) {
      parent.children = parent.children.filter((id) => id !== rootId)
    }
  }

  for (const id of collectSubtreeIds(nodes, rootId)) {
    delete nodes[id]
  }
}

/**
 * Remove the given root nodes and their entire subtrees from a flat node map,
 * in place. Each root is unlinked from its parent's `children[]` (via the
 * `parentId` cache) and every descendant is deleted from the map.
 *
 * Used to cascade-remove `base.visual-component-ref` nodes — when their target
 * VC is deleted in the editor, or is missing when a site is loaded — so no
 * orphaned slot-instances or user content are left behind. Callers pick which
 * refs to remove; this performs the identical tree surgery either way.
 *
 * Safe to call inside a Mutative recipe or on a plain object map.
 */
export function removeNodeSubtrees(
  nodes: Record<string, BaseNode>,
  rootNodeIds: readonly string[],
): void {
  for (const rootId of rootNodeIds) {
    deleteSubtree(nodes, rootId, { unlinkParent: true })
  }
}
