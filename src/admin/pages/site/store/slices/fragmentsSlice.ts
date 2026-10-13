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
 * Placement mirrors saved layouts: a section or component lands at the
 * location resolved from the current selection (inside a container, else
 * after it), in the document the plan was made for.
 */

import {
  applyResolvedFragment,
  type FragmentApplyResult,
  type FragmentInsertDocument,
  type ResolvedFragmentPlan,
} from '@core/fragments'
import { resolveInsertLocation } from '@site/store/insertLocation'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { reconcileFrameworkClasses } from './site/framework/reconcile'
import { buildSiteHelpers, resolveActiveTreeTarget } from './site/helpers'

interface FragmentsSlice {
  /** Whether the Insert fragment dialog is open. */
  insertFragmentModalOpen: boolean
  openInsertFragmentModal: () => void
  closeInsertFragmentModal: () => void

  /**
   * Apply a resolved fragment insert plan in ONE undo step. A page fragment
   * adds its page; a section or component lands in the document the plan was
   * made for and its first root is selected. Returns null when that document
   * is no longer the active one, there is nowhere to place the fragment, or
   * the collab write gate refused the edit.
   */
  insertFragment: (plan: ResolvedFragmentPlan) => FragmentApplyResult | null
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

function sameDocument(a: FragmentInsertDocument | null, b: FragmentInsertDocument | undefined): boolean {
  if (!a || !b) return false
  if (a.kind === 'page') return b.kind === 'page' && a.pageId === b.pageId
  return b.kind === 'visualComponent' && a.vcId === b.vcId
}

export const createFragmentsSlice: EditorStoreSliceCreator<FragmentsSlice> = (set, get) => {
  const { mutateSite, mutateActiveTreeAndSite } = buildSiteHelpers(set, get)

  return {
    insertFragmentModalOpen: false,
    openInsertFragmentModal: () => set({ insertFragmentModalOpen: true }),
    closeInsertFragmentModal: () => set({ insertFragmentModalOpen: false }),

    insertFragment: (plan) => {
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
      if (!sameDocument(fragmentInsertDocument(state), plan.document)) return null
      const target = resolveActiveTreeTarget(state)
      if (!target) return null
      const location = resolveInsertLocation(target.tree, state.selectedNodeId ?? target.tree.rootNodeId)
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
