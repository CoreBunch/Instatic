/**
 * Undo/redo actions for the site slice.
 *
 * History is stored as Mutative patch pairs (see `HistoryEntry`): each entry
 * carries `inverse` patches (applied on undo) and `forward` patches (applied on
 * redo), scoped to the SiteDocument. Undo/redo `apply()` the relevant patch set
 * to the current `site` — O(change), no full-site clone — then move the entry
 * between the past/future stacks and re-derive the `packageJson` / `siteRuntime`
 * mirrors from the restored site.
 */

import { apply } from 'mutative'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import { collectDirtyFromSitePatches, mergeDirtyMarks } from './dirtyTracking'
import type { SiteSlice, SiteSliceHelpers } from './types'

type UndoRedoActions = Pick<SiteSlice, 'undo' | 'redo'>

export function createUndoRedoActions({ get, set }: SiteSliceHelpers): UndoRedoActions {
  return {
    undo: () => {
      const { _historyPast, site } = get()
      if (_historyPast.length === 0 || !site) return
      const entry = _historyPast[_historyPast.length - 1]!
      const restored = apply(site, entry.inverse)
      const packageJson = clonePackageJson(restored.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(restored.runtime)
      // Undo changes the same paths the original mutation did — the restored
      // pages/VCs must be re-saved.
      const dirty = collectDirtyFromSitePatches(entry.inverse, restored)
      set((state) => {
        state._historyPast.pop()
        state._historyFuture.push(entry)
        // End any in-progress input-coalescing burst so the next keystroke
        // starts a fresh undo entry rather than folding into the undone one.
        state._historyCoalesceKey = null
        state.site = { ...restored, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.canUndo = state._historyPast.length > 0
        state.canRedo = true
        state.hasUnsavedChanges = true
        mergeDirtyMarks(state._dirtySave, dirty)
        // Keep activePageId valid
        if (!state.site.pages.find((p) => p.id === state.activePageId)) {
          state.activePageId = state.site.pages[0]?.id ?? null
        }
      })
    },

    redo: () => {
      const { _historyFuture, site } = get()
      if (_historyFuture.length === 0 || !site) return
      const entry = _historyFuture[_historyFuture.length - 1]!
      const restored = apply(site, entry.forward)
      const packageJson = clonePackageJson(restored.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(restored.runtime)
      // Redo re-applies the mutation's paths — mark the replayed pages/VCs.
      const dirty = collectDirtyFromSitePatches(entry.forward, restored)
      set((state) => {
        state._historyFuture.pop()
        state._historyPast.push(entry)
        state._historyCoalesceKey = null
        state.site = { ...restored, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.canUndo = true
        state.canRedo = state._historyFuture.length > 0
        state.hasUnsavedChanges = true
        mergeDirtyMarks(state._dirtySave, dirty)
        // Keep activePageId valid
        if (!state.site.pages.find((p) => p.id === state.activePageId)) {
          state.activePageId = state.site.pages[0]?.id ?? null
        }
      })
    },
  }
}
