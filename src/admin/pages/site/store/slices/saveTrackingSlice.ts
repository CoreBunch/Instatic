/**
 * Save-tracking slice — the unsaved-changes flag and the patch-derived
 * save-dirty accumulator (see slices/site/dirtyTracking.ts).
 *
 * Autosave takes a snapshot (which resets the accumulator), ships only the
 * named page/component/layout ids, and merges the snapshot back on save
 * failure so nothing is lost. `mutateSite`-family helpers feed the
 * accumulator from each mutation's site-relative patches.
 */

import type { EditorStoreSliceCreator } from '@site/store/types'
import { emptyDirtyMarks, mergeDirtyMarks, type DirtyMarks } from './site/dirtyTracking'

export interface SaveTrackingSlice {
  // Unsaved changes guard
  hasUnsavedChanges: boolean
  setHasUnsavedChanges: (value: boolean) => void

  /**
   * Patch-derived save-dirty accumulator — which pages/VCs/layouts changed
   * since the last successful save.
   */
  _dirtySave: DirtyMarks
  /** Conservative full-save mark (imports, fresh sites). */
  markAllDirtyForSave: () => void
  /** Return the accumulated marks and reset the accumulator. */
  takeDirtySaveSnapshot: () => DirtyMarks
  /** Merge a failed save's snapshot back so the next save retries it. */
  restoreDirtySaveSnapshot: (marks: DirtyMarks) => void
}

declare module '@site/store/types' {
  // Surface this slice's fields on the combined EditorStore type.
  interface EditorStore extends SaveTrackingSlice {}
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
    const current = get()._dirtySave
    const snapshot: DirtyMarks = {
      all: current.all,
      pageIds: new Set(current.pageIds),
      componentIds: new Set(current.componentIds),
      layoutIds: new Set(current.layoutIds),
    }
    set((state) => {
      state._dirtySave = emptyDirtyMarks()
    })
    return snapshot
  },

  restoreDirtySaveSnapshot: (marks) =>
    set((state) => {
      mergeDirtyMarks(state._dirtySave, marks)
    }),
})
