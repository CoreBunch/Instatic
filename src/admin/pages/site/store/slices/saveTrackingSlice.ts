/**
 * Save-tracking slice — the unsaved-changes flag and the patch-derived
 * save-dirty accumulator (see slices/site/dirtyTracking.ts).
 *
 * Autosave takes a snapshot (which resets the accumulator), ships only the
 * named page/component/layout writes plus explicit deleted-row ids, and
 * merges the snapshot back on save failure so nothing is lost.
 * `mutateSite`-family helpers feed the accumulator from each mutation's
 * site-relative patches.
 *
 * NETTING happens at snapshot time, against the live site document:
 *   - a deleted-mark for a row that EXISTS in the store again (deleted then
 *     re-created / undone within one save window) is dropped — the row ships
 *     as a plain write, net effect preserved;
 *   - a write-mark for a row that NO LONGER exists is dropped — shipping it
 *     would resurrect a row the user deleted.
 * The server's "id in both changed and deleted sets → 400" check backstops
 * this rule. `peekDirtySaveSnapshot` applies the same netting WITHOUT
 * resetting the accumulator — the beforeunload flush uses it because a
 * fire-and-forget save must leave the marks in place for a retry.
 */

import type { SiteDocument } from '@core/page-tree'
import type { EditorStoreSliceCreator } from '@site/store/types'
import { emptyDirtyMarks, mergeDirtyMarks, type DirtyMarks } from './site/dirtyTracking'

interface SaveTrackingSlice {
  // Unsaved changes guard
  hasUnsavedChanges: boolean
  setHasUnsavedChanges: (value: boolean) => void

  /**
   * Patch-derived save-dirty accumulator — which pages/VCs/layouts changed
   * (and which were deleted) since the last successful save.
   */
  _dirtySave: DirtyMarks
  /** Conservative full-save mark (imports, fresh sites) — ships as a replace-mode save. */
  markAllDirtyForSave: () => void
  /** Return the accumulated marks (netted against the live site) and reset the accumulator. */
  takeDirtySaveSnapshot: () => DirtyMarks
  /** Netted copy of the accumulated marks WITHOUT resetting — for fire-and-forget flushes. */
  peekDirtySaveSnapshot: () => DirtyMarks
  /** Merge a failed save's snapshot back so the next save retries it. */
  restoreDirtySaveSnapshot: (marks: DirtyMarks) => void
}

declare module '@site/store/types' {
  // Surface this slice's fields on the combined EditorStore type.
  interface EditorStore extends SaveTrackingSlice {}
}

/** Copy `ids`, keeping only those for which `keep` holds. */
function filteredSet(ids: ReadonlySet<string>, keep: (id: string) => boolean): Set<string> {
  const out = new Set<string>()
  for (const id of ids) if (keep(id)) out.add(id)
  return out
}

/** Independent, netted copy of the marks (see module doc for the netting rule). */
function nettedDirtySnapshot(current: DirtyMarks, site: SiteDocument | null): DirtyMarks {
  if (!site) {
    // No document to net against — return the marks as accumulated.
    return {
      all: current.all,
      pageIds: new Set(current.pageIds),
      componentIds: new Set(current.componentIds),
      layoutIds: new Set(current.layoutIds),
      deletedPageIds: new Set(current.deletedPageIds),
      deletedComponentIds: new Set(current.deletedComponentIds),
      deletedLayoutIds: new Set(current.deletedLayoutIds),
    }
  }
  const pageIds = new Set(site.pages.map((p) => p.id))
  const componentIds = new Set(site.visualComponents.map((vc) => vc.id))
  const layoutIds = new Set(site.layouts.map((l) => l.id))
  return {
    all: current.all,
    pageIds: filteredSet(current.pageIds, (id) => pageIds.has(id)),
    componentIds: filteredSet(current.componentIds, (id) => componentIds.has(id)),
    layoutIds: filteredSet(current.layoutIds, (id) => layoutIds.has(id)),
    deletedPageIds: filteredSet(current.deletedPageIds, (id) => !pageIds.has(id)),
    deletedComponentIds: filteredSet(current.deletedComponentIds, (id) => !componentIds.has(id)),
    deletedLayoutIds: filteredSet(current.deletedLayoutIds, (id) => !layoutIds.has(id)),
  }
}

export const createSaveTrackingSlice: EditorStoreSliceCreator<SaveTrackingSlice> = (
  set,
  get,
) => ({
  hasUnsavedChanges: false,

  setHasUnsavedChanges: (value) => set({ hasUnsavedChanges: value }),

  _dirtySave: emptyDirtyMarks(),

  markAllDirtyForSave: () =>
    set((state) => {
      state._dirtySave.all = true
    }),

  takeDirtySaveSnapshot: () => {
    const { _dirtySave: current, site } = get()
    const snapshot = nettedDirtySnapshot(current, site)
    set((state) => {
      state._dirtySave = emptyDirtyMarks()
    })
    return snapshot
  },

  peekDirtySaveSnapshot: () => {
    const { _dirtySave: current, site } = get()
    return nettedDirtySnapshot(current, site)
  },

  restoreDirtySaveSnapshot: (marks) =>
    set((state) => {
      mergeDirtyMarks(state._dirtySave, marks)
    }),
})
