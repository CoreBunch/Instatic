/**
 * Save-conflict resolution actions — multi-admin conflict safety (level A).
 *
 * When an incremental save 409s, the failed save restores its dirty marks and
 * `setSaveConflicts` fills the pending list; the conflict banner then offers
 * two resolutions per conflicted target:
 *
 *   Keep mine   — bump the target's base seq to the remote seq. The local
 *                 edits stay dirty and the NEXT save overwrites the remote
 *                 version — a stated decision instead of a silent one.
 *   Load theirs — the banner fetches the remote state and hands it here as a
 *                 `RemoteConflictSnapshot`; the target is swapped in place
 *                 (or removed, when deleted remotely) WITHOUT undo history,
 *                 its dirty marks are cleared, and the base seq syncs to the
 *                 remote seq.
 *
 * Both resolutions clear the undo history: history entries are site-relative
 * Mutative patches with array indices — replaying them across a remotely
 * swapped tree is undefined behavior. (Keep-mine keeps the local document
 * intact, so its history survives.)
 *
 * VC consumer propagation: adopting a remote Visual Component re-syncs the
 * slot instances of every ref to it, and adopting a remote VC DELETION
 * cascades ref removal — both through `mutateSite`, so the affected consumer
 * pages earn REAL dirty marks (they now differ from storage and must ship
 * with the next save). The history entries those mutations push are cleared
 * along with everything else.
 */

import type { BaseNode } from '@core/page-tree'
import { findHomePage, reconcileSiteExplorerInPlace, reindexNodeParents } from '@core/page-tree'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import type { EditorStore } from '@site/store/types'
import type { Draft } from 'mutative'
import { renderCache } from '@site/canvas/renderCache'
import { clearCanvasSelectionDraft } from '../selectionSlice'
import { allTreeNodeMaps, syncAllVCRefSlotInstances } from '../vcSlotReconcile'
import { cascadeRemoveVCRefs } from '../vcTreeOps'
import { reconcileFrameworkClasses } from './framework/reconcile'
import type { SiteSlice, SiteSliceHelpers } from './types'

type ConflictActions = Pick<
  SiteSlice,
  'setSaveConflicts' | 'resolveSaveConflictKeepMine' | 'resolveSaveConflictTheirs'
>

function dropConflict(state: Draft<EditorStore>, table: string, rowId: string): void {
  state.saveConflicts = state.saveConflicts.filter(
    (c) => !(c.table === table && c.rowId === rowId),
  )
}

function clearUndoHistory(state: Draft<EditorStore>): void {
  state._historyPast = []
  state._historyFuture = []
  state._historyCoalesceKey = null
  state.canUndo = false
  state.canRedo = false
}

export function createConflictActions({ set, mutateSite }: SiteSliceHelpers): ConflictActions {
  return {
    setSaveConflicts: (conflicts) =>
      set((state) => {
        state.saveConflicts = [...conflicts]
      }),

    resolveSaveConflictKeepMine: (conflict) =>
      set((state) => {
        dropConflict(state, conflict.table, conflict.rowId)
        if (conflict.table === 'site') {
          state.shellBaseSeq = Math.max(state.shellBaseSeq, conflict.seq)
        } else {
          state.baseSeqs[conflict.rowId] = Math.max(
            state.baseSeqs[conflict.rowId] ?? 0,
            conflict.seq,
          )
        }
        // The failed save restored its dirty marks — nothing else to do; the
        // next save ships the same rows and now passes the seq check.
      }),

    resolveSaveConflictTheirs: (snapshot) => {
      // Consumer propagation FIRST (see module doc): mutateSite gives the
      // affected pages real patch-derived dirty marks. Neither helper needs
      // the VC swapped in yet — the sync takes the remote VC as an argument,
      // and the cascade only reads ref nodes.
      if (snapshot.table === 'components') {
        if (snapshot.row) {
          const vc = snapshot.row
          mutateSite((site) => {
            syncAllVCRefSlotInstances(allTreeNodeMaps(site), vc.id, vc)
          })
        } else {
          mutateSite((site) => {
            for (const page of site.pages) {
              cascadeRemoveVCRefs(page.nodes as Record<string, BaseNode>, snapshot.rowId)
            }
            for (const vc of site.visualComponents) {
              if (vc.id !== snapshot.rowId) {
                cascadeRemoveVCRefs(vc.tree.nodes as Record<string, BaseNode>, snapshot.rowId)
              }
            }
          })
        }
      }

      // Remote HTML swaps under the canvas — drop cached renders wholesale.
      renderCache.clear()

      set((state) => {
        const site = state.site
        if (!site) return
        dropConflict(state, snapshot.table, snapshot.table === 'site' ? 'default' : snapshot.rowId)

        switch (snapshot.table) {
          case 'site': {
            // Overwrite every shell field in place; the row-backed
            // collections stay untouched. `conditions` is the one optional
            // shell key — drop it explicitly when the remote shell lacks it.
            Object.assign(site, snapshot.shell)
            if (snapshot.shell.conditions === undefined) delete site.conditions
            reconcileFrameworkClasses(site)
            reconcileSiteExplorerInPlace(site)
            state.packageJson = clonePackageJson(snapshot.shell.packageJson)
            state.siteRuntime = cloneSiteRuntimeConfig(snapshot.shell.runtime)
            state.shellBaseSeq = snapshot.seq
            break
          }

          case 'pages': {
            state._dirtySave.pageIds.delete(snapshot.rowId)
            state._dirtySave.deletedPageIds.delete(snapshot.rowId)
            const idx = site.pages.findIndex((p) => p.id === snapshot.rowId)
            const wasActive =
              state.activePageId === snapshot.rowId &&
              (state.activeDocument === null || state.activeDocument.kind === 'page')
            if (snapshot.row) {
              reindexNodeParents(snapshot.row.nodes)
              if (idx >= 0) site.pages[idx] = snapshot.row
              else site.pages.push(snapshot.row)
              state.baseSeqs[snapshot.rowId] = snapshot.seq
            } else {
              if (idx >= 0) site.pages.splice(idx, 1)
              delete state.baseSeqs[snapshot.rowId]
              if (state.activePageId === snapshot.rowId) {
                state.activePageId = (findHomePage(site.pages) ?? site.pages[0])?.id ?? null
              }
              // A page-kind activeDocument pointing at the removed page would
              // make mutateActiveTree silently no-op — fall back to page mode.
              if (
                state.activeDocument?.kind === 'page' &&
                state.activeDocument.pageId === snapshot.rowId
              ) {
                state.activeDocument = null
              }
            }
            reconcileSiteExplorerInPlace(site)
            // The canvas may hold selection/hover state into the replaced
            // (or removed) tree — clear it when that document was active.
            if (wasActive) clearCanvasSelectionDraft(state)
            break
          }

          case 'components': {
            state._dirtySave.componentIds.delete(snapshot.rowId)
            state._dirtySave.deletedComponentIds.delete(snapshot.rowId)
            const idx = site.visualComponents.findIndex((vc) => vc.id === snapshot.rowId)
            const wasActive =
              state.activeDocument?.kind === 'visualComponent' &&
              state.activeDocument.vcId === snapshot.rowId
            if (snapshot.row) {
              reindexNodeParents(snapshot.row.tree.nodes)
              if (idx >= 0) site.visualComponents[idx] = snapshot.row
              else site.visualComponents.push(snapshot.row)
              state.baseSeqs[snapshot.rowId] = snapshot.seq
            } else {
              if (idx >= 0) site.visualComponents.splice(idx, 1)
              delete state.baseSeqs[snapshot.rowId]
              // The open document was deleted remotely — fall back to page mode.
              if (wasActive) state.activeDocument = null
            }
            reconcileSiteExplorerInPlace(site)
            if (wasActive) clearCanvasSelectionDraft(state)
            break
          }

          case 'layouts': {
            state._dirtySave.layoutIds.delete(snapshot.rowId)
            state._dirtySave.deletedLayoutIds.delete(snapshot.rowId)
            const idx = site.layouts.findIndex((layout) => layout.id === snapshot.rowId)
            if (snapshot.row) {
              reindexNodeParents(snapshot.row.nodes)
              if (idx >= 0) site.layouts[idx] = snapshot.row
              else site.layouts.push(snapshot.row)
              state.baseSeqs[snapshot.rowId] = snapshot.seq
            } else {
              if (idx >= 0) site.layouts.splice(idx, 1)
              delete state.baseSeqs[snapshot.rowId]
            }
            break
          }
        }

        clearUndoHistory(state)
      })
    },
  }
}
