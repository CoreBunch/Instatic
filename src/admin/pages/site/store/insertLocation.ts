/**
 * resolveInsertLocation — shared "where should a new node land?" resolver.
 *
 * Every UI flow that inserts a node relative to a user-clicked target (toolbar
 * picker, canvas right-click, DOM-panel right-click, clipboard paste, etc.)
 * resolves the actual parent + insertion index the same way:
 *
 *   - The page root and any module declaring `canHaveChildren: true` accept
 *     children. The new node is appended as the target's last child.
 *   - Anything else (Text, Button, Image, an opaque slot-instance, etc.) is a
 *     leaf — the new node is inserted as the *next sibling* under the
 *     target's parent. Without this fallback the right-click "Insert module
 *     here" / paste actions silently no-op on leaf targets.
 *
 *   - Visual-Component refs are containers in the tree sense (their
 *     slot-instance children are managed by the editor), but user-authored
 *     content goes inside the FIRST slot-instance, not as a direct child of
 *     the ref. We redirect into that slot here so callers don't have to
 *     repeat the logic. A VC ref WITHOUT any slot-instances (the component
 *     declares no slot params) is treated as a leaf — there is no addressable
 *     place to nest user content, so we fall through to sibling-after under
 *     the ref's parent. The earlier behaviour of returning null silently
 *     no-op'd every right-click "Insert module here" / paste on a slotless
 *     VC ref, which read as a broken click in the editor.
 */

import { registry } from '@core/module-engine'
import type { NodeTree, PageNode } from '@core/page-tree'

export interface InsertLocation {
  parentId: string
  /** Insertion index inside parent. Undefined means "append to end". */
  index: number | undefined
}

/**
 * Sibling-after fallback: insert at `target`'s parent, right after `target`.
 * Returns null only when the target has no parent (e.g. the root) — that's
 * the genuine dead-end case where the caller has nowhere to place content.
 */
function siblingAfter(page: NodeTree<PageNode>, targetNodeId: string): InsertLocation | null {
  const parent = Object.values(page.nodes).find((n) =>
    n.children.includes(targetNodeId),
  )
  if (!parent) return null
  const idx = parent.children.indexOf(targetNodeId)
  return { parentId: parent.id, index: idx >= 0 ? idx + 1 : undefined }
}

export function resolveInsertLocation(
  page: NodeTree<PageNode>,
  targetNodeId: string,
): InsertLocation | null {
  const target = page.nodes[targetNodeId]
  if (!target) return null

  // The page root always accepts children even if its module entry is
  // unregistered (load-order edge case) — pages are never leaves.
  const isRoot = page.rootNodeId === targetNodeId
  const definition = registry.get(target.moduleId)
  const acceptsChildren = isRoot || definition?.canHaveChildren === true

  if (!acceptsChildren) {
    // Leaf target → insert as next sibling under target's parent.
    return siblingAfter(page, targetNodeId)
  }

  // base.visual-component-ref is a container, but user content must land
  // inside its first slot-instance child — direct children are managed by
  // syncSlotInstances. The redirect happens here so every caller doesn't
  // repeat the logic. When the referenced component has no slot params there
  // are no slot-instances to land in, so we treat the ref as a leaf and place
  // the new node as a sibling-after under its parent.
  if (target.moduleId === 'base.visual-component-ref') {
    const slotInstanceChildId = target.children.find(
      (childId) => page.nodes[childId]?.moduleId === 'base.slot-instance',
    )
    if (slotInstanceChildId) {
      return { parentId: slotInstanceChildId, index: undefined }
    }
    return siblingAfter(page, targetNodeId)
  }

  return { parentId: targetNodeId, index: undefined }
}
