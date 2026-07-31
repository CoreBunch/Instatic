/**
 * Helper for cloning node-scoped CSS classes alongside node duplication.
 *
 * Per-node "module-style" classes carry `scope: { type: 'node', nodeId, role:
 * 'module-style' }` — they are conceptually owned by exactly one node. Any
 * mutation that clones one or more nodes (duplicateNode, duplicatePage, paste,
 * convert-to-VC) MUST also clone every node-scoped class whose `scope.nodeId`
 * is in the cloned set, with a fresh class id and the `scope.nodeId` rewritten
 * to point at the new node.
 *
 * Without this remap two nodes end up sharing the same scoped class — the
 * publisher emits ONE CSS rule per class name, so editing the original's
 * per-node style silently restyles the duplicate. See `F-0005`.
 *
 * `clipboardSlice.pasteNode` and `visualComponentsSlice.clonePageSubtreeToFlatNodes`
 * already implement this contract inline; this helper is the single source of
 * truth so duplicateNode / duplicatePage can use the same shape.
 */

import { nanoid } from 'nanoid'
import type { StyleRule } from './styleRule'

/**
 * For a set of nodes being cloned (oldId → newId), produce:
 *   - `added`: a list of new StyleRule entries the caller should write into
 *     `site.styleRules`. Each entry has a fresh id and a rewritten `scope.nodeId`.
 *   - `classIdRemap`: a map of oldClassId → newClassId for every node-scoped
 *     class that was cloned. Cloned-node classIds arrays should be remapped
 *     through this map (`classIdRemap.get(cid) ?? cid` — non-scoped class ids
 *     are not remapped and should pass through unchanged).
 *
 * Non-scoped classes (framework / regular reusable classes) are NOT cloned —
 * they are shared registry entries by design and the duplicate keeps the same
 * class id.
 *
 * Classes scoped to a node OUTSIDE the cloned set are NOT cloned and NOT
 * remapped — the duplicate inherits the reference verbatim, preserving the
 * existing semantics for cross-cloned-set scoping.
 */
export function cloneScopedClassesForNodeMap(
  nodeIdMap: Map<string, string>,
  classes: Record<string, StyleRule>,
): { added: StyleRule[]; classIdRemap: Map<string, string> } {
  const added: StyleRule[] = []
  const classIdRemap = new Map<string, string>()
  const now = Date.now()

  for (const cls of Object.values(classes)) {
    if (cls.scope?.type !== 'node') continue
    const newScopeNodeId = nodeIdMap.get(cls.scope.nodeId)
    if (!newScopeNodeId) continue

    const newId = nanoid()
    classIdRemap.set(cls.id, newId)
    added.push({
      ...cls,
      id: newId,
      scope: { ...cls.scope, nodeId: newScopeNodeId },
      styles: { ...cls.styles },
      ...(cls.stylePriorities
        ? { stylePriorities: { ...cls.stylePriorities } }
        : {}),
      // Deep-clone every per-context override bag so the clone owns independent
      // maps — the bare `...cls` spread would share the same bag objects with
      // the source rule (the shared-reference hazard F-0005 addresses for
      // scoped styles). Custom conditions reference the shared site-level
      // registry by id, so cloning the bags is sufficient.
      contextStyles: Object.fromEntries(
        Object.entries(cls.contextStyles).map(([ctx, s]) => [ctx, { ...s }]),
      ),
      ...(cls.contextStylePriorities
        ? {
            contextStylePriorities: Object.fromEntries(
              Object.entries(cls.contextStylePriorities).map(([ctx, priorities]) => [
                ctx,
                { ...priorities },
              ]),
            ),
          }
        : {}),
      ...(cls.tags !== undefined ? { tags: [...cls.tags] } : {}),
      createdAt: now,
      updatedAt: now,
    })
  }

  return { added, classIdRemap }
}
