/**
 * Fragments slice — the editor side of `@core/fragments`.
 *
 * Owns the Insert fragment dialog's open flag (Spotlight "Insert fragment
 * from file…") and `insertFragment`, which applies a resolved insert plan in
 * ONE undoable store transaction: the core `applyResolvedFragment` writes
 * rules, tokens, fonts, components and nodes (or the new page), and the
 * framework utility classes are regenerated in the same recipe when the
 * insert added a colour or a scale step.
 *
 * Placement (`FragmentInsertPlacement`), in the document the plan was made
 * for:
 * - `after-selection` (the default, and the Insert fragment dialog's only
 *   mode): right after the selected element (`resolveSiblingInsertLocation`),
 *   or at the end of the document when nothing or the root is selected. It
 *   never goes INSIDE a selected container, so a second section inserted
 *   while the first is still selected lands below it.
 * - `inside-selection`: inside the selected container, like a paste
 *   (`resolveInsertLocation`); the end of the document when nothing is
 *   selected.
 * - `end`: the end of the document whatever is selected.
 */

import {
  applyResolvedFragment,
  type FragmentApplyResult,
  type FragmentInsertDocument,
  type FragmentInsertPlacement,
  type ResolvedFragmentPlan,
} from '@core/fragments'
import type { NodeTree, PageNode } from '@core/page-tree'
import {
  resolveInsertLocation,
  resolveSiblingInsertLocation,
  type InsertLocation,
} from '@site/store/insertLocation'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { reconcileFrameworkClasses } from './site/framework/reconcile'
import { buildSiteHelpers, resolveActiveTreeTarget } from './site/helpers'
import { isSameActiveDocument } from './uiSlice'

interface FragmentsSlice {
  /** Whether the Insert fragment dialog is open. */
  insertFragmentModalOpen: boolean
  openInsertFragmentModal: () => void
  closeInsertFragmentModal: () => void

  /**
   * Apply a resolved fragment insert plan in ONE undo step. A page fragment
   * adds its page; a section or component lands in the document the plan was
   * made for, at `placement` (default `after-selection`), and its first root
   * is selected. Returns null when that document is no longer the active
   * one, there is nowhere to place the fragment, or the collab write gate
   * refused the edit.
   */
  insertFragment: (plan: ResolvedFragmentPlan, placement?: FragmentInsertPlacement) => FragmentApplyResult | null
}

declare module '@site/store/types' {
  // Surface this slice's fields on the combined EditorStore type.
  interface EditorStore extends FragmentsSlice {}
}

/** The document a section or component fragment would land in, or null. */
export function fragmentInsertDocument(
  state: Pick<EditorStore, 'site' | 'activeDocument' | 'activePageId'>,
): FragmentInsertDocument | null {
  if (!state.site) return null
  if (state.activeDocument?.kind === 'visualComponent') {
    return { kind: 'visualComponent', vcId: state.activeDocument.vcId }
  }
  const pageId = state.activeDocument?.kind === 'page' ? state.activeDocument.pageId : state.activePageId
  return pageId ? { kind: 'page', pageId } : null
}

/** Where a section or component lands in `tree` for `placement`. */
function fragmentInsertLocation(
  tree: NodeTree<PageNode>,
  selectedNodeId: string | null,
  placement: FragmentInsertPlacement,
): InsertLocation | null {
  const selected = selectedNodeId && tree.nodes[selectedNodeId] ? selectedNodeId : tree.rootNodeId
  if (placement === 'end') return resolveInsertLocation(tree, tree.rootNodeId)
  if (placement === 'inside-selection') return resolveInsertLocation(tree, selected)
  return resolveSiblingInsertLocation(tree, selected)
}

export const createFragmentsSlice: EditorStoreSliceCreator<FragmentsSlice> = (set, get) => {
  const { mutateSite, mutateActiveTreeAndSite } = buildSiteHelpers(set, get)

  return {
    insertFragmentModalOpen: false,
    openInsertFragmentModal: () => set({ insertFragmentModalOpen: true }),
    closeInsertFragmentModal: () => set({ insertFragmentModalOpen: false }),

    insertFragment: (plan, placement = 'after-selection') => {
      const state = get()
      if (!state.site) return null
      let result: FragmentApplyResult | null = null

      if (plan.page) {
        const accepted = mutateSite((site) => {
          const applied = applyResolvedFragment(site, plan, null)
          if (applied.frameworkChanged) reconcileFrameworkClasses(site)
          result = { rootIds: applied.rootIds, pageId: applied.pageId }
        })
        return accepted ? result : null
      }

      // The plan was made for one document; never drop it into another.
      if (!plan.document || !isSameActiveDocument(fragmentInsertDocument(state), plan.document)) return null
      const target = resolveActiveTreeTarget(state)
      if (!target) return null
      const location = fragmentInsertLocation(target.tree, state.selectedNodeId, placement)
      if (!location) return null

      const accepted = mutateActiveTreeAndSite((tree, site) => {
        const applied = applyResolvedFragment(site, plan, {
          tree,
          parentId: location.parentId,
          index: location.index,
        })
        if (applied.frameworkChanged) reconcileFrameworkClasses(site)
        result = { rootIds: applied.rootIds }
        return true
      })
      if (!accepted) return null
      const rootId = (result as FragmentApplyResult | null)?.rootIds[0]
      if (rootId) get().selectNode(rootId)
      return result
    },
  }
}
