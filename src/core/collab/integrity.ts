/**
 * Tree-integrity reconcile — deterministic healing of the rare tree damage
 * concurrent CRDT merges can produce (Yjs guarantees CONVERGENCE, not
 * domain-level tree invariants):
 *
 *   - duplicate ids inside a `children` array (concurrent move interleavings)
 *   - dangling child ids whose node entry was deleted concurrently
 *   - orphan nodes reachable from no children array (re-attached under the
 *     root, sorted by id for determinism)
 *   - a node listed in two parents (first traversal wins; later duplicates
 *     dropped)
 *
 * MUST be deterministic: it runs in every peer's projection on identical
 * converged input, so identical output keeps all peers rendering the same
 * tree without another round-trip.
 */
import type { BaseNode } from '@core/page-tree'

export function reconcileTreeIntegrity(
  nodes: Record<string, BaseNode>,
  rootNodeId: string,
): void {
  const claimed = new Set<string>([rootNodeId])

  /**
   * BFS-heal one subtree in place from `startId`: claim every reachable node
   * and rewrite each children array to drop root-refs, dangling ids, and any
   * child already claimed by another parent (single-parent invariant).
   */
  const healFrom = (startId: string): void => {
    const queue: string[] = [startId]
    while (queue.length > 0) {
      const id = queue.shift()!
      const node = nodes[id]
      if (!node) continue
      const healed: string[] = []
      for (const childId of node.children) {
        if (childId === rootNodeId) continue // a root can never be a child
        if (!nodes[childId]) continue // dangling reference
        if (claimed.has(childId)) continue // duplicate / second parent
        claimed.add(childId)
        healed.push(childId)
        queue.push(childId)
      }
      if (healed.length !== node.children.length) node.children = healed
    }
  }

  healFrom(rootNodeId)

  const root = nodes[rootNodeId]
  if (!root) return

  // Orphans: nodes unreachable from the root. Re-attach only orphan SUBTREE
  // ROOTS — orphans not referenced as a child by any OTHER orphan — so a
  // multi-node orphaned subtree keeps its shape instead of every node landing
  // flat under root with two parents (root AND its orphan parent). Healing
  // each attached root then claims its descendants, dropping the duplicate
  // parent links inside the subtree.
  const orphanIds = Object.keys(nodes).filter((id) => !claimed.has(id))
  const referencedByOrphan = new Set<string>()
  for (const id of orphanIds) {
    for (const childId of nodes[id]!.children) referencedByOrphan.add(childId)
  }
  const orphanRoots = orphanIds.filter((id) => !referencedByOrphan.has(id)).sort()
  for (const id of orphanRoots) {
    if (claimed.has(id)) continue
    claimed.add(id)
    root.children = [...root.children, id]
    healFrom(id)
  }

  // Any nodes STILL unclaimed form orphan-only cycles (no reachable root):
  // break each cycle by attaching its lowest id, then heal-walk claims the
  // rest. Deterministic: lowest id first, re-checked after every attach.
  for (const id of Object.keys(nodes).sort()) {
    if (claimed.has(id)) continue
    claimed.add(id)
    root.children = [...root.children, id]
    healFrom(id)
  }
}
