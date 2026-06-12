/**
 * Layouts slice — save / insert / rename / delete for user-saved layouts.
 *
 * A saved layout is a named subtree snapshot (`SavedLayout` in @core/layouts):
 * the right-clicked node plus its whole subtree, with every referenced style
 * rule captured alongside. Capture and restore go through the SAME snapshot
 * engine as the clipboard (`@site/store/subtreeSnapshot`), so inserting a
 * layout behaves exactly like pasting the original selection: fresh node ids,
 * scoped classes cloned with remapped scope, framework classes re-matched by
 * name, regular classes reused or re-imported.
 *
 * Layouts live on `site.layouts` and persist to `data_rows`
 * (table_id = 'layouts') through the editor's incremental save — every
 * mutation here goes through `mutateSite`/`mutateActiveTreeAndSite` so it is
 * undoable and dirty-tracked like any other site change.
 *
 * Mode rules:
 * - Saving captures from the active PAGE only (VC definitions are not valid
 *   layout sources — their slot outlets mean nothing on a page). The context
 *   menu hides the action in VC mode, mirroring Componentize.
 * - Inserting targets the active canvas tree (page OR VC definition). In VC
 *   mode, layouts containing component refs are guarded against dependency
 *   cycles with the same `wouldCreateCycle` check `insertComponentRef` uses.
 */

import { nanoid } from 'nanoid'
import type { Page, PageNode } from '@core/page-tree'
import { removeNodeSubtrees } from '@core/page-tree'
import { layoutNameError, type SavedLayout } from '@core/layouts'
import { wouldCreateCycle } from '@core/visualComponents'
import { firstOutletId, treeHasOutlet } from '@core/templates'
import { pushToast } from '@ui/components/Toast'
import { resolveInsertLocation, type InsertLocation } from '@site/store/insertLocation'
import {
  collectReferencedClasses,
  collectSubtreeNodes,
  insertSnapshotSubtrees,
} from '@site/store/subtreeSnapshot'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { buildSiteHelpers, resolveActiveTreeTarget } from './site/helpers'

/**
 * The active Page when the editor is in page mode; null in VC mode. Mirrors
 * the page branch of `resolveActiveTreeTarget` (slices cannot import
 * `selectActiveCanvasPage` from store.ts — that would be a module cycle).
 */
function getActivePage(
  state: Pick<EditorStore, 'site' | 'activeDocument' | 'activePageId'>,
): Page | null {
  if (!state.site) return null
  if (state.activeDocument?.kind === 'visualComponent') return null
  const pageId =
    state.activeDocument?.kind === 'page' ? state.activeDocument.pageId : state.activePageId
  return state.site.pages.find((p) => p.id === pageId) ?? null
}

/**
 * Thrown when a layout name fails validation (empty or duplicate) so the
 * naming UI can render the message inline instead of a generic failure.
 */
export class SavedLayoutNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavedLayoutNameError'
  }
}

interface LayoutsSlice {
  /**
   * Capture `nodeId` + its subtree from the active page as a new saved
   * layout. Returns the new layout id.
   *
   * Throws `SavedLayoutNameError` for empty/duplicate names. Returns null
   * when there is no active page, the node doesn't resolve, or the node is
   * the page root (capturing "the whole body" has no meaningful re-insertion
   * target — same guard as copy).
   */
  saveNodeAsLayout: (nodeId: string, name: string) => string | null

  /**
   * Insert a saved layout into the active canvas tree. Placement mirrors
   * every other insert flow: an explicit drop target wins, otherwise the
   * location is resolved from the current selection via
   * `resolveInsertLocation`. Returns the new root node id, or null when the
   * insert was blocked (no active tree, outlet conflict, VC cycle).
   */
  insertLayout: (layoutId: string, explicitTarget?: InsertLocation) => string | null

  /** Rename a saved layout. Throws `SavedLayoutNameError` for invalid names. */
  renameLayout: (layoutId: string, name: string) => void

  /** Delete a saved layout. */
  deleteLayout: (layoutId: string) => void
}

declare module '@site/store/types' {
  // Surface this slice's fields on the combined EditorStore type.
  interface EditorStore extends LayoutsSlice {}
}

export const createLayoutsSlice: EditorStoreSliceCreator<LayoutsSlice> = (
  set,
  get,
) => {
  const { mutateSite, mutateActiveTreeAndSite } = buildSiteHelpers(set, get)

  return {
    saveNodeAsLayout: (nodeId, name) => {
      const state = get()
      const site = state.site
      if (!site) return null
      // Page mode only — a VC definition is not a valid layout source.
      const page = getActivePage(state)
      if (!page) return null
      if (!page.nodes[nodeId] || page.rootNodeId === nodeId) return null

      const nameError = layoutNameError(name, site.layouts)
      if (nameError) throw new SavedLayoutNameError(nameError)

      const subtree = collectSubtreeNodes(page, [nodeId])
      if (!subtree) return null
      const classes = collectReferencedClasses(subtree.nodes, site.styleRules)

      const layout: SavedLayout = {
        id: nanoid(),
        name: name.trim(),
        rootNodeId: nodeId,
        nodes: subtree.nodes,
        classes,
        createdAt: Date.now(),
      }
      const saved = mutateSite((draftSite) => {
        draftSite.layouts.push(layout)
      })
      return saved ? layout.id : null
    },

    insertLayout: (layoutId, explicitTarget) => {
      const state = get()
      const site = state.site
      if (!site) return null
      const layout = site.layouts.find((l) => l.id === layoutId)
      if (!layout) return null
      const target = resolveActiveTreeTarget(state)
      if (!target) return null
      const activeTree = target.tree

      const location =
        explicitTarget ??
        resolveInsertLocation(activeTree, state.selectedNodeId ?? activeTree.rootNodeId)
      if (!location) return null

      // One-outlet-per-document invariant — same guard as paste. The inserter
      // already disables conflicting items inline; this is the store-level
      // backstop for programmatic callers.
      if (firstOutletId(layout.nodes) !== null && treeHasOutlet(activeTree)) {
        pushToast({
          kind: 'warning',
          title: 'Only one content outlet',
          body: 'This layout includes a content outlet and this document already has one.',
          location: 'site-editor',
        })
        return null
      }

      // Heal the snapshot against the CURRENT VC roster: refs to since-deleted
      // VCs are stripped (whole ref subtree), matching how page validation
      // heals dangling refs on load.
      const knownVcIds = new Set(site.visualComponents.map((vc) => vc.id))
      const referencedVcIds = new Set<string>()
      const danglingRefIds: string[] = []
      for (const [id, node] of Object.entries(layout.nodes)) {
        if (node.moduleId !== 'base.visual-component-ref') continue
        const componentId = node.props.componentId
        if (typeof componentId !== 'string' || !componentId) continue
        if (knownVcIds.has(componentId)) referencedVcIds.add(componentId)
        else danglingRefIds.push(id)
      }

      // VC mode: inserting a ref whose target (transitively) references the
      // open VC would create a dependency cycle — same rule insertComponentRef
      // enforces.
      if (state.activeDocument?.kind === 'visualComponent') {
        const hostVcId = state.activeDocument.vcId
        for (const refId of referencedVcIds) {
          if (wouldCreateCycle(site.visualComponents, hostVcId, refId)) {
            pushToast({
              kind: 'warning',
              title: 'Circular component reference',
              body: 'This layout contains a component that references the component being edited.',
              location: 'site-editor',
            })
            return null
          }
        }
      }

      let snapshotNodes = layout.nodes
      let snapshotRootId: string | null = layout.rootNodeId
      if (danglingRefIds.length > 0) {
        // Work on a detached copy — `layout.nodes` is frozen store state.
        const copy: Record<string, PageNode> = {}
        for (const [id, node] of Object.entries(layout.nodes)) {
          copy[id] = { ...node, children: [...node.children] }
        }
        removeNodeSubtrees(copy, danglingRefIds)
        snapshotNodes = copy
        if (!copy[layout.rootNodeId]) snapshotRootId = null
      }
      if (snapshotRootId === null) return null

      const newRootIds: string[] = []
      mutateActiveTreeAndSite((tree, draftSite) => {
        newRootIds.push(...insertSnapshotSubtrees(
          tree,
          draftSite,
          {
            rootNodeIds: [snapshotRootId],
            nodes: snapshotNodes,
            classes: layout.classes,
          },
          location,
        ))
        return newRootIds.length > 0
      })

      const newRootId = newRootIds[0] ?? null
      if (newRootId) get().selectNode(newRootId)
      return newRootId
    },

    renameLayout: (layoutId, name) => {
      const site = get().site
      if (!site) return
      const nameError = layoutNameError(name, site.layouts, layoutId)
      if (nameError) throw new SavedLayoutNameError(nameError)

      mutateSite((draftSite) => {
        const layout = draftSite.layouts.find((l) => l.id === layoutId)
        if (!layout) return false
        const trimmed = name.trim()
        if (layout.name === trimmed) return false
        layout.name = trimmed
      })
    },

    deleteLayout: (layoutId) => {
      mutateSite((draftSite) => {
        const index = draftSite.layouts.findIndex((l) => l.id === layoutId)
        if (index === -1) return false
        draftSite.layouts.splice(index, 1)
      })
    },
  }
}
