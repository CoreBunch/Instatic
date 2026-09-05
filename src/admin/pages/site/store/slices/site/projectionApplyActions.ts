/**
 * Site slice — `applyProjectionImport`, the God Mode HTML panel's write path.
 *
 * Splices a uid-preserving import result (`importProjectionHtml`) into the
 * active tree in ONE undoable mutation, writing exactly what the import's
 * diff says changed: patched nodes are replaced under their old ids (with
 * their metadata carried), created nodes are added, vanished uids are
 * deleted, and every other node of the subtree is left untouched — same
 * object, no patch. Class names typed in the HTML link to registry classes
 * exactly as the lossy import does (`insertImportedNodes`), and nodes the
 * apply deleted are pruned from the canvas selection.
 *
 * The write scope is the point, not an optimisation: every node object the
 * recipe reassigns becomes a whole-node rewrite in the collab doc, and the
 * per-doc `Y.UndoManager` pins each deleted struct against garbage
 * collection for as long as the step is undoable. Rewriting the whole
 * projected subtree on every debounced keystroke made a typing session on a
 * large page retain the entire tree per apply until the renderer ran out of
 * memory. Parentage is re-linked around the written nodes only, for the
 * same reason (a whole-tree reindex touches every node's draft).
 */
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import {
  createStyleRuleOrderAllocator,
  indexStyleRulesByName,
  linkImportedClassNames,
} from './importLinking'
import type { SiteSlice, SiteSliceHelpers } from './types'

type ProjectionApplyActions = Pick<SiteSlice, 'applyProjectionImport'>

export function createProjectionApplyActions({
  set,
  mutateActiveTreeAndSite,
}: SiteSliceHelpers): ProjectionApplyActions {
  return {
    applyProjectionImport: (result) => {
      const applied = mutateActiveTreeAndSite((tree, site) => {
        if (!tree.nodes[result.rootId] || !result.nodes[result.rootId]) return false

        const classesByName = indexStyleRulesByName(site.styleRules)
        const allocateStyleRuleOrder = createStyleRuleOrderAllocator(site.styleRules)
        const { createdIds, patchedIds, deletedIds } = result.diff

        for (const id of deletedIds) delete tree.nodes[id]

        const written = [...patchedIds, ...createdIds]
        for (const id of written) {
          const node = result.nodes[id]
          tree.nodes[id] = {
            ...node,
            // The importer's copies carry no parentage. A patched node keeps
            // the parent it has; a created (or moved) node is stamped from
            // its parent below — that parent's `children` changed, so it is
            // written too.
            parentId: tree.nodes[id]?.parentId ?? null,
            classIds: linkImportedClassNames(
              node.classIds,
              site.styleRules,
              classesByName,
              allocateStyleRuleOrder,
            ),
          }
        }
        for (const id of written) {
          for (const childId of tree.nodes[id].children) {
            const child = tree.nodes[childId]
            if (child && child.parentId !== id) child.parentId = id
          }
        }
        return true
      })
      if (applied) {
        set((state) => {
          pruneCanvasSelectionDraft(state)
        })
      }
      return applied
    },
  }
}
