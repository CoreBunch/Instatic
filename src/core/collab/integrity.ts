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

  // Walk from root, healing children arrays in place.
  const queue: string[] = [rootNodeId]
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

  // Orphans: nodes never reached from the root — re-attach under root,
  // sorted by id so every peer picks the same order.
  const root = nodes[rootNodeId]
  if (!root) return
  const orphans = Object.keys(nodes)
    .filter((id) => !claimed.has(id))
    .sort()
  if (orphans.length > 0) {
    root.children = [...root.children, ...orphans]
    for (const id of orphans) claimed.add(id)
  }
}
