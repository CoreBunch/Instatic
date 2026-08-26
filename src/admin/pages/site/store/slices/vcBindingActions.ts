/**
 * Param↔node binding actions for Visual Components.
 *
 * Two channels, one responsibility — connecting a VC param to something a node
 * renders:
 *   - `propBindings`  → the param's value replaces a module prop (text, href, …)
 *   - `classBindings` → the param's value selects a CLASS, which is the only
 *     way a param can change appearance (`class` is not a prop).
 *
 * Extracted from `visualComponentsSlice.ts` when the class channel pushed that
 * file past its size budget. Built as a factory over the slice's `mutateSite`
 * helper rather than a free function, because every action here is one
 * undoable site mutation.
 */

import type { StoreApi } from 'zustand'
import type { EditorStore } from '@site/store/types'
import type { SiteSliceHelpers } from './site/types'

type Get = StoreApi<EditorStore>['getState']
type MutateSite = SiteSliceHelpers['mutateSite']

export interface VcBindingActions {
  setNodeClassBinding(nodeId: string, paramId: string, classByValue: Record<string, string>): void
  setNodePropBinding(nodeId: string, propKey: string, paramId: string): void
  clearNodePropBinding(nodeId: string, propKey: string): void
}

export function createVcBindingActions(mutateSite: MutateSite, get: Get): VcBindingActions {
  return {
    setNodeClassBinding(nodeId, paramId, classByValue) {
      const { activeDocument } = get()
      if (activeDocument?.kind !== 'visualComponent') {
        throw new Error('setNodeClassBinding: a visual component must be the active document')
      }

      mutateSite((site) => {
        const vc = (site.visualComponents ?? []).find((v) => v.id === activeDocument.vcId)
        if (!vc) return false
        const node = vc.tree.nodes[nodeId]
        if (!node) return false

        const entries = Object.entries(classByValue)
        if (entries.length === 0) {
          if (!node.classBindings?.[paramId]) return false
          delete node.classBindings[paramId]
          // Drop the bag once empty so an unbound node round-trips identically
          // to one that never had a binding.
          if (Object.keys(node.classBindings).length === 0) delete node.classBindings
          return true
        }

        if (!node.classBindings) node.classBindings = {}
        node.classBindings[paramId] = Object.fromEntries(entries)
        return true
      })
    },

    setNodePropBinding(nodeId, propKey, paramId) {
      const { activeDocument, activePageId } = get()
      const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
      if (activeDocument?.kind !== 'visualComponent' && pageId == null) {
        throw new Error('setNodePropBinding: no page is active in the editor')
      }

      mutateSite((site) => {
        if (activeDocument?.kind === 'visualComponent') {
          const vc = (site.visualComponents ?? []).find((v) => v.id === activeDocument.vcId)
          if (!vc) return false
          const node = vc.tree.nodes[nodeId]
          if (!node) return false
          if (node.propBindings?.[propKey]?.paramId === paramId) return false
          if (!node.propBindings) node.propBindings = {}
          node.propBindings[propKey] = { paramId }
          return true
        }

        const page = (site.pages ?? []).find((p) => p.id === pageId)
        if (!page) return false
        const node = page.nodes[nodeId]
        if (!node) return false
        if (node.propBindings?.[propKey]?.paramId === paramId) return false
        if (!node.propBindings) node.propBindings = {}
        node.propBindings[propKey] = { paramId }
        return true
      })
    },

    clearNodePropBinding(nodeId, propKey) {
      const { activeDocument, activePageId } = get()
      const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
      if (activeDocument?.kind !== 'visualComponent' && pageId == null) {
        throw new Error('clearNodePropBinding: no page is active in the editor')
      }

      mutateSite((site) => {
        if (activeDocument?.kind === 'visualComponent') {
          const vc = (site.visualComponents ?? []).find((v) => v.id === activeDocument.vcId)
          if (!vc) return false
          const node = vc.tree.nodes[nodeId]
          if (!node?.propBindings?.[propKey]) return false

          const removedParamId = node.propBindings[propKey]?.paramId
          delete node.propBindings[propKey]

          // GC the param once nothing references it any more. BOTH channels
          // count: a param that no longer feeds a prop may still be driving a
          // variant, and collecting it there would silently strip the class
          // from every instance.
          if (removedParamId) {
            const stillBound = new Set<string>()
            for (const n of Object.values(vc.tree.nodes)) {
              for (const binding of Object.values(n.propBindings ?? {})) {
                stillBound.add(binding.paramId)
              }
              for (const boundParamId of Object.keys(n.classBindings ?? {})) {
                stillBound.add(boundParamId)
              }
            }
            if (!stillBound.has(removedParamId)) {
              const idx = vc.params.findIndex((p) => p.id === removedParamId)
              if (idx !== -1) vc.params.splice(idx, 1)
            }
          }
          return true
        }

        const page = (site.pages ?? []).find((p) => p.id === pageId)
        if (!page) return false
        const node = page.nodes[nodeId]
        if (!node?.propBindings?.[propKey]) return false
        delete node.propBindings[propKey]
        return true
      })
    },
  }
}
