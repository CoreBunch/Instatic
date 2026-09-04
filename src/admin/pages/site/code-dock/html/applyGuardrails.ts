/**
 * applyGuardrails — the destructive-diff summary behind the HTML panel's
 * confirm dialog (docs/features/god-mode.md → "HTML panel" → "Guardrails").
 *
 * `importProjectionHtml` reports which base-subtree nodes an apply would
 * delete or dismantle before anything mutates. Most deletions are silent —
 * removing a tag is what an HTML editor is for — but two kinds warrant a
 * confirm: nodes the author locked, and Component/slot structures (a VC
 * ref, a slot instance, a slot outlet), whose removal is hard to notice in
 * HTML and expensive to rebuild. This module turns the diff's id lists into
 * a short, accurate summary: one entry per top-level removal, named as the
 * layer panel names it, with removed descendants folded into their ancestor
 * so deleting one Component instance reads as one line, not one per slot.
 */
import { registry } from '@core/module-engine'
import type { ProjectionImportDiff } from '@core/htmlImport'
import { getNodeDisplayName, type NodeTree, type PageNode } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'

export type RemovalReason = 'locked' | 'component' | 'slot' | 'outlet'

export interface DestructiveRemoval {
  id: string
  /** The node's layer-panel name. */
  name: string
  /** Why this removal needs a confirm, in display order. */
  reasons: RemovalReason[]
  /**
   * True when the node survives but its marker was re-tagged to a plain
   * element, dismantling the Component/slot structure it represented.
   */
  retyped: boolean
}

const STRUCTURAL_REASONS: Record<string, RemovalReason> = {
  'base.visual-component-ref': 'component',
  'base.slot-instance': 'slot',
  'base.slot-outlet': 'outlet',
}

export function summarizeDestructiveApply(
  diff: ProjectionImportDiff,
  tree: NodeTree<PageNode>,
  visualComponents: ReadonlyArray<VisualComponent>,
): DestructiveRemoval[] {
  const deleted = new Set(diff.deletedIds)
  const flagged = new Set([...diff.deletedLockedIds, ...diff.deletedStructuralIds])

  const describe = (id: string, retyped: boolean): DestructiveRemoval | null => {
    const node = tree.nodes[id]
    if (!node) return null
    const reasons: RemovalReason[] = []
    if (!retyped && node.locked) reasons.push('locked')
    const structural = STRUCTURAL_REASONS[node.moduleId]
    if (structural) reasons.push(structural)
    return { id, name: getNodeDisplayName(node, registry.get(node.moduleId), visualComponents), reasons, retyped }
  }

  const removals: DestructiveRemoval[] = []
  // Walk deletions in the diff's order so the summary follows the document,
  // and skip any flagged node whose ancestor is also being deleted.
  for (const id of diff.deletedIds) {
    if (!flagged.has(id) || hasDeletedAncestor(tree, id, deleted)) continue
    const removal = describe(id, false)
    if (removal) removals.push(removal)
  }
  for (const id of diff.retypedStructuralIds) {
    const removal = describe(id, true)
    if (removal) removals.push(removal)
  }
  return removals
}

function hasDeletedAncestor(tree: NodeTree<PageNode>, id: string, deleted: Set<string>): boolean {
  let parentId = tree.nodes[id]?.parentId
  while (parentId) {
    if (deleted.has(parentId)) return true
    parentId = tree.nodes[parentId]?.parentId
  }
  return false
}
