/**
 * Save-tracking slice — the unsaved-changes flag, the patch-derived
 * save-dirty accumulator (see slices/site/dirtyTracking.ts), and the
 * multi-admin sync bookkeeping: per-row + shell base seqs (the
 * conflict-detection bases every incremental save ships) and the
 * pending-conflicts list behind the SaveConflictBanner. Conflict RESOLUTION
 * actions live in slices/site/conflictActions.ts — they mutate the document.
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
import type { SaveConflict } from '@core/persistence/saveConflict'
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

  /**
   * Conflict-detection bases: rowId → the sync seq this editor last
   * synchronized with (seeded at load, bumped to the response seq on every
   * successful save — for DELETED rows too, so an undo that resurrects a
   * saved-deleted row carries the right base instead of reading as a blind
   * overwrite). Every incremental save ships the subset covering its
   * changed + deleted rows; the server 409s when storage is newer.
   */
  baseSeqs: Record<string, number>
  /** The shell's counterpart to `baseSeqs` — one coarse seq for the whole shell. */
  shellBaseSeq: number
  /**
   * Conflicts reported by the last 409'd save, pending user resolution via
   * the conflict banner (Keep mine / Load theirs — see site/conflictActions).
   * Autosave is suppressed while non-empty; a successful save clears it.
   */
  saveConflicts: SaveConflict[]
  /** Replace the base-seq maps wholesale — the load/reload path. */
  seedBaseSeqs: (rowSeqs: Record<string, number>, shellSeq: number) => void
  /**
   * After a successful save: bump the bases of everything the save shipped to
   * the response seq. Incremental saves cover the dirty-snapshot ids + the
   * shell; replace-mode saves rebuild the whole map from the shipped site.
   */
  commitSavedBaseSeqs: (savedSite: SiteDocument, dirty: DirtyMarks | undefined, seq: number) => void
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

  baseSeqs: {},
  shellBaseSeq: 0,
  saveConflicts: [],

  seedBaseSeqs: (rowSeqs, shellSeq) =>
    set((state) => {
      state.baseSeqs = { ...rowSeqs }
      state.shellBaseSeq = shellSeq
    }),

  commitSavedBaseSeqs: (savedSite, dirty, seq) =>
    set((state) => {
      if (!dirty || dirty.all) {
        // Replace-mode save — storage now holds exactly the shipped site.
        const next: Record<string, number> = {}
        for (const page of savedSite.pages) next[page.id] = seq
        for (const vc of savedSite.visualComponents) next[vc.id] = seq
        for (const layout of savedSite.layouts) next[layout.id] = seq
        state.baseSeqs = next
      } else {
        const shippedIds = [
          ...dirty.pageIds, ...dirty.deletedPageIds,
          ...dirty.componentIds, ...dirty.deletedComponentIds,
          ...dirty.layoutIds, ...dirty.deletedLayoutIds,
        ]
        for (const id of shippedIds) state.baseSeqs[id] = seq
      }
      // Correct even when the server skipped the shell write (content
      // unchanged): the stored shell seq then stays BELOW this save's seq,
      // and the conflict check only fires on stored > base.
      state.shellBaseSeq = seq
      // A successful save proves no shipped row conflicted — stale banner
      // entries (all conflicts come from shipped rows) are moot.
      state.saveConflicts = []
    }),
})
