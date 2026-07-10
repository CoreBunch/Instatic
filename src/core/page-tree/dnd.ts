import type { PageNode } from './pageNode'
import type { NodeTree } from './treeSchema'
import { getParent, isAncestor } from './selectors'
import { isDomNode, domCanHaveChildren } from './baseNode'

export type PageTreeDropPosition = 'before' | 'after' | 'inside'
type PageTreeDropZone = PageTreeDropPosition

export interface PageTreeDropTarget {
  /** The pivot drag id: the row/handle the user grabbed. */
  draggedId: string
  /** Every dragged id when this is a multi-drag; `[draggedId]` for single. */
  draggedIds: string[]
  parentId: string
  index: number
  position: PageTreeDropPosition
  slot: 'default'
  overId: string
}

interface ResolvePageTreeDropTargetInput {
  tree: NodeTree<PageNode>
  /** The pivot id: the node the user grabbed. */
  draggedId: string
  /**
   * All ids being dragged. Defaults to `[draggedId]` for single-drag callers.
   * Cycle, lock, and no-self-drop checks consider every id in this list.
   */
  draggedIds?: string[]
  overId: string
  zone: PageTreeDropZone
  canHaveChildren: (moduleId: string) => boolean
}

export function resolvePageTreeDropTarget({
  tree,
  draggedId,
  draggedIds: draggedIdsInput,
  overId,
  zone,
  canHaveChildren,
}: ResolvePageTreeDropTargetInput): PageTreeDropTarget | null {
  const dragged = tree.nodes[draggedId]
  const over = tree.nodes[overId]
  if (!dragged || !over) return null

  const draggedIds = draggedIdsInput ?? [draggedId]

  for (const id of draggedIds) {
    if (id === tree.rootNodeId) return null
    const node = tree.nodes[id]
    if (!node) return null
    if (node.locked) return null
  }

  if (draggedIds.includes(overId)) return null

  if (zone === 'inside') {
    // DOM-native nodes: check void elements. Module-based nodes: check registry.
    const canHave = isDomNode(over) ? domCanHaveChildren(over.tag!) : canHaveChildren(over.moduleId)
    if (!canHave) return null

    // Slot instances under a VC ref are structural and locked, but their
    // children are the user-authored slot fill. Allow drops into those slots;
    // keep every other locked node closed.
    if (over.locked && over.moduleId !== 'base.slot-instance') return null

    // A visual-component-ref's direct children are managed slot-instance nodes.
    // User-authored content must enter through one of those slot instances.
    if (over.moduleId === 'base.visual-component-ref') return null

    for (const id of draggedIds) {
      if (isAncestor(tree, id, overId)) return null
    }

    const index = normalizeIndexAfterRemoval(tree, draggedId, overId, over.children.length)
    return noOpTarget(tree, draggedId, overId, index)
      ? null
      : {
          draggedId,
          draggedIds,
          parentId: overId,
          index,
          position: 'inside',
          slot: 'default',
          overId,
        }
  }

  if (overId === tree.rootNodeId) return null
  const parent = getParent(tree, overId)
  if (!parent) return null
  if (parent.locked) return null

  // Direct children of a visual-component-ref are slot instances owned by
  // syncSlotInstances; do not allow arbitrary siblings under that parent.
  if (parent.moduleId === 'base.visual-component-ref') return null

  for (const id of draggedIds) {
    if (isAncestor(tree, id, parent.id)) return null
  }

  const overIndex = parent.children.indexOf(overId)
  if (overIndex === -1) return null

  const rawIndex = zone === 'before' ? overIndex : overIndex + 1
  const index = normalizeIndexAfterRemoval(tree, draggedId, parent.id, rawIndex)

  return noOpTarget(tree, draggedId, parent.id, index)
    ? null
    : {
        draggedId,
        draggedIds,
        parentId: parent.id,
        index,
        position: zone,
        slot: 'default',
        overId,
      }
}

function normalizeIndexAfterRemoval(
  tree: NodeTree<PageNode>,
  draggedId: string,
  parentId: string,
  rawIndex: number,
): number {
  const currentParent = getParent(tree, draggedId)
  if (!currentParent || currentParent.id !== parentId) return rawIndex

  const currentIndex = currentParent.children.indexOf(draggedId)
  if (currentIndex === -1 || currentIndex >= rawIndex) return rawIndex
  return rawIndex - 1
}

function noOpTarget(
  tree: NodeTree<PageNode>,
  draggedId: string,
  parentId: string,
  index: number,
): boolean {
  const currentParent = getParent(tree, draggedId)
  if (!currentParent || currentParent.id !== parentId) return false
  return currentParent.children.indexOf(draggedId) === index
}
