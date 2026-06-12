/**
 * visualComponentsSlice — Visual Components Data Layer store slice.
 *
 * Architecture source: Contribution #619 §2, §3, §6, §10 (Task #436)
 *
 * Manages site.visualComponents[] CRUD.
 * State lives in site.visualComponents (owned by siteSlice);
 * this slice owns only the action methods — same pattern as filesSlice.
 *
 * Every write boundary:
 *  - Calls validateComponentName() and throws on invalid name.
 *  - Calls wouldCreateCycle() at insertComponentRef boundary and throws on cycle.
 *
 * Constraint #269: MUST NOT import from editor/.
 * This is a pure data-layer slice.
 */

import { nanoid } from 'nanoid'
import type { EditorStoreSliceCreator } from '@site/store/types'
import type { VisualComponent, VCParam, VCNode } from '@core/visualComponents'
import type { BaseNode, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import {
  validateComponentName,
  validateParamName,
  wouldCreateCycle,
} from '@core/visualComponents'
import { buildSiteHelpers } from './site/helpers'
import { syncAllVCRefSlotInstances, allTreeNodeMaps } from './vcSlotReconcile'
import {
  VisualComponentNameError,
  VisualComponentParamNameError,
  VisualComponentRecursionError,
  cascadeRemoveVCRefs,
  clonePageSubtreeToFlatNodes,
  collectSubtreeNodeIds,
  collectVCRefsFromPageSubtree,
} from './vcTreeOps'

interface VisualComponentsSlice {
  /**
   * Create a new Visual Component with the given (free-form) name.
   * Returns the new VC's id.
   *
   * Throws VisualComponentNameError if:
   * - `name` is empty / whitespace-only, or already used by another VC in the site.
   */
  createVisualComponent(name: string): string

  /**
   * Rename a Visual Component.
   *
   * Throws VisualComponentNameError if the new name is invalid.
   * No-op if the id does not exist.
   * Self-rename (same name) is a no-op and does NOT throw.
   */
  renameVisualComponent(id: string, newName: string): void

  /**
   * Delete a Visual Component by id.
   * No-op if the id does not exist.
   */
  deleteVisualComponent(id: string): void

  /**
   * Add a param to a VC's param surface.
   * Returns the new param's stable id.
   * No-op if the VC does not exist.
   */
  addParam(vcId: string, name: string, type: VCParam['type'], defaultValue?: unknown): string

  /**
   * Remove a param from a VC by its stable id AND clean up all references to it:
   *  - Deletes every propBinding in the VC tree that references the param.
   *  - For every page node that is a base.visual-component-ref pointing at this VC,
   *    deletes node.props.propOverrides[paramId] and (for slot params)
   *    removes the matching base.slot-instance child via syncSlotInstances.
   *
   * No-op if the VC or param does not exist.
   */
  removeParamWithCleanup(vcId: string, paramId: string): void

  /**
   * Add a new node to a VC's canvas tree under `parentNodeId`.
   *
   * If `index` is provided, the node is inserted at that position among the
   * parent's existing children; otherwise it is appended.
   *
   * Throws VisualComponentRecursionError if `newNode` is a
   * base.visual-component-ref that would create a cycle.
   *
   * No-op if the VC or parent node does not exist.
   */
  addNodeToVc(vcId: string, parentNodeId: string, newNode: VCNode, index?: number): void

  /**
   * Bind a node's prop to a VC param.
   * Operates on the active VC tree (activeDocument.kind === 'visualComponent') or
   * the active page (activeDocument is null or kind === 'page').
   * Throws if no page is active in the editor.
   * No-op if the node or document is not found.
   */
  setNodePropBinding(nodeId: string, propKey: string, paramId: string): void

  /**
   * Remove a prop binding from a node.
   * In VC mode: GCs the param from vc.params if no other node still references it.
   * No-op if the node or binding is not found.
   */
  clearNodePropBinding(nodeId: string, propKey: string): void

  /**
   * Update the defaultValue of a VC param.
   * No-op if the VC or param is not found.
   */
  updateParamDefaultValue(vcId: string, paramId: string, value: unknown): void

  /**
   * Rename a VC param. Validates non-empty + uniqueness before mutating.
   * Throws VisualComponentParamNameError on invalid name.
   * Because propBindings and propOverrides reference paramId (not name),
   * no other rewriting is needed.
   * No-op if the VC or param is not found.
   */
  renameParam(vcId: string, paramId: string, newName: string): void

  /**
   * Partial update of a param's metadata: required, description, enumOptions.
   * Strips enumOptions when param.type !== 'enum' (defensive).
   * Treats empty description as undefined (removes the field).
   * No-op if the VC or param is not found.
   */
  updateParamMeta(vcId: string, paramId: string, patch: { required?: boolean; description?: string; enumOptions?: string[] }): void

  /**
   * Convert an existing page node (and its entire subtree) into a new Visual Component.
   *
   * The source node is removed from the page and replaced with a
   * base.visual-component-ref pointing at the new VC. The editor switches
   * to the new VC's canvas automatically.
   *
   * Returns the new VC's id.
   *
   * Throws VisualComponentNameError if `name` is invalid.
   * Throws VisualComponentRecursionError if the subtree would introduce a
   * reference cycle (checked via subtree VC reference integrity).
   * Throws a plain Error for:
   *   - Called while editing a visual component (activeDocument.kind === 'visualComponent')
   *   - No page is active in the editor (activeDocument === null && activePageId === null)
   *   - nodeId not found on the active page
   *   - Source node is a base.visual-component-ref or base.body (cannot re-wrap)
   *   - nodeId is the page root
   */
  convertNodeToComponent(nodeId: string, name: string): string
}

// ---------------------------------------------------------------------------
// Slice implementation
// ---------------------------------------------------------------------------

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends VisualComponentsSlice {}
}

export const createVisualComponentsSlice: EditorStoreSliceCreator<VisualComponentsSlice> = (set, get) => {
  // Build the closure-shared mutation helpers. `mutateSite` commits undo
  // history only when the producer reports a semantic document mutation.
  const { mutateSite, mutateSiteState, mutateSiteWithExplorerReconcile } = buildSiteHelpers(set, get)

  return {

  createVisualComponent(name) {
    const { site } = get()
    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    const validation = validateComponentName(name, site.visualComponents ?? [])
    if (!validation.ok) {
      throw new VisualComponentNameError(validation.reason, validation.error)
    }

    const trimmedName = name.trim()
    const id = nanoid()
    const rootNodeId = nanoid()
    const now = Date.now()

    const rootNode: VCNode = {
      id: rootNodeId,
      moduleId: 'base.body',
      props: {},
      children: [],
      breakpointOverrides: {},
      classIds: [],
      parentId: null,
    }

    const newVC: VisualComponent = {
      id,
      name: trimmedName,
      tree: {
        nodes: { [rootNodeId]: rootNode },
        rootNodeId,
      },
      params: [],
      classIds: [],
      createdAt: now,
    }

    mutateSiteWithExplorerReconcile((site) => {
      if (!site.visualComponents) site.visualComponents = []
      site.visualComponents.push(newVC)
      return true
    })

    return id
  },

  renameVisualComponent(id, newName) {
    const { site } = get()
    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    const validation = validateComponentName(newName, site.visualComponents ?? [], id)
    if (!validation.ok) {
      throw new VisualComponentNameError(validation.reason, validation.error)
    }

    const trimmedName = newName.trim()

    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === id)
      if (!vc) return false
      if (vc.name === trimmedName) return false
      vc.name = trimmedName
      return true
    })
  },

  deleteVisualComponent(id) {
    mutateSiteWithExplorerReconcile((site) => {
      const idx = (site.visualComponents ?? []).findIndex((v) => v.id === id)
      if (idx === -1) return false

      // Remove the VC from the registry first so the cascade loops below
      // don't see it as a valid target (the remaining VCs are all "other" VCs).
      site.visualComponents.splice(idx, 1)

      // Cascade: remove every base.visual-component-ref pointing at `id` from
      // all page trees, along with their full subtrees (slot-instances + content).
      for (const page of site.pages) {
        cascadeRemoveVCRefs(page.nodes as Record<string, BaseNode>, id)
      }

      // Cascade: same sweep over every remaining VC's tree.
      for (const vc of site.visualComponents) {
        cascadeRemoveVCRefs(vc.tree.nodes as Record<string, BaseNode>, id)
      }
      return true
    })
  },

  addParam(vcId, name, type, defaultValue = '') {
    // Validate param name BEFORE entering Immer (pure read from current state)
    const { site } = get()
    if (site) {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (vc) {
        const validation = validateParamName(name, vc.params)
        if (!validation.ok) {
          throw new VisualComponentParamNameError(validation.reason, validation.error)
        }
      }
    }

    const paramId = nanoid()
    const trimmedName = name.trim()

    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (!vc) return false

      const newParam: VCParam = {
        id: paramId,
        name: trimmedName,
        type,
        defaultValue,
        required: false,
      }
      vc.params.push(newParam)

      // If a slot param was added, sync every VC ref on every page so the new
      // slot gets a materialized slot-instance child immediately.
      if (type === 'slot') {
        syncAllVCRefSlotInstances(allTreeNodeMaps(site), vcId, vc)
      }
      return true
    })

    return paramId
  },

  removeParamWithCleanup(vcId, paramId) {
    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (!vc) return false

      const paramIdx = vc.params.findIndex((p) => p.id === paramId)
      if (paramIdx === -1) return false

      const param = vc.params[paramIdx]
      const isSlot = param.type === 'slot'

      // 1. Remove propBindings referencing this param from the VC's flat tree
      for (const node of Object.values(vc.tree.nodes)) {
        if (node.propBindings) {
          for (const propKey of Object.keys(node.propBindings)) {
            if (node.propBindings[propKey].paramId === paramId) {
              delete node.propBindings[propKey]
            }
          }
        }
      }

      // 2. Remove the param itself (before syncing, so syncSlotInstances sees the final params)
      vc.params.splice(paramIdx, 1)

      // 3. Clean up every ref for this VC — in pages AND nested in other VC
      //    trees (ISS-026): drop propOverrides[paramId] from each ref…
      for (const treeNodes of allTreeNodeMaps(site)) {
        for (const node of Object.values(treeNodes)) {
          if (
            node.moduleId === 'base.visual-component-ref' &&
            node.props.componentId === vcId
          ) {
            const overrides = node.props.propOverrides
            if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
              delete (overrides as Record<string, unknown>)[paramId]
            }
          }
        }
      }

      // …then, if a slot param was removed, re-sync slot-instance children
      // for every ref so the deleted slot's instance disappears.
      if (isSlot) {
        syncAllVCRefSlotInstances(allTreeNodeMaps(site), vcId, vc)
      }
      return true
    })
  },

  addNodeToVc(vcId, parentNodeId, newNode, index) {
    const { site } = get()
    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    const vcs = site.visualComponents ?? []

    // Cycle guard — runs BEFORE any state mutation (slice write boundary, §3)
    if (newNode.moduleId === 'base.visual-component-ref') {
      const componentId = (newNode.props as Record<string, unknown>).componentId
      if (typeof componentId === 'string') {
        if (wouldCreateCycle(vcs, vcId, componentId)) {
          throw new VisualComponentRecursionError(
            `Circular component reference: embedding "${componentId}" inside "${vcId}" would create a cycle.`,
          )
        }
      }
    }

    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (!vc) return false

      const parent = vc.tree.nodes[parentNodeId]
      if (!parent) return false

      // Duplicate-node-id guard — silently no-op if node ID already exists in the tree
      if (vc.tree.nodes[newNode.id]) return false

      // Register the new node in the flat map
      vc.tree.nodes[newNode.id] = newNode

      // Add to parent's children list
      if (index === undefined || index >= parent.children.length) {
        parent.children.push(newNode.id)
      } else {
        const insertAt = Math.max(0, index)
        parent.children.splice(insertAt, 0, newNode.id)
      }
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

        // GC: remove orphan param if no other node references it
        if (removedParamId) {
          const stillBound = new Set<string>()
          for (const n of Object.values(vc.tree.nodes)) {
            if (n.propBindings) {
              for (const binding of Object.values(n.propBindings)) {
                stillBound.add(binding.paramId)
              }
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

  updateParamDefaultValue(vcId, paramId, value) {
    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (!vc) return false
      const param = vc.params.find((p) => p.id === paramId)
      if (!param) return false
      if (Object.is(param.defaultValue, value)) return false
      param.defaultValue = value
      return true
    }, { coalesceKey: `vcparam:${vcId}:${paramId}` }) // coalesce per-keystroke edits
  },

  renameParam(vcId, paramId, newName) {
    // Validate BEFORE entering Immer (reads current state via get())
    const { site } = get()
    if (site) {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (vc) {
        const validation = validateParamName(newName, vc.params, paramId)
        if (!validation.ok) {
          throw new VisualComponentParamNameError(validation.reason, validation.error)
        }
      }
    }

    const trimmedName = newName.trim()

    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (!vc) return false
      const param = vc.params.find((p) => p.id === paramId)
      if (!param) return false
      if (param.name === trimmedName) return false
      const isSlot = param.type === 'slot'
      param.name = trimmedName

      // If this is a slot param, sync all VC refs on all pages so the
      // slot-instance's slotName prop tracks the renamed param.
      if (isSlot) {
        syncAllVCRefSlotInstances(allTreeNodeMaps(site), vcId, vc)
      }
      return true
    })
  },

  updateParamMeta(vcId, paramId, patch) {
    mutateSite((site) => {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (!vc) return false
      const param = vc.params.find((p) => p.id === paramId)
      if (!param) return false

      let changed = false
      if ('required' in patch) {
        const nextRequired = patch.required ?? false
        if (param.required !== nextRequired) {
          param.required = nextRequired
          changed = true
        }
      }
      if ('description' in patch) {
        const nextDescription = patch.description || undefined
        if (param.description !== nextDescription) {
          param.description = nextDescription
          changed = true
        }
      }
      if ('enumOptions' in patch) {
        if (param.type === 'enum') {
          const nextOptions = patch.enumOptions
          const currentOptions = param.enumOptions
          const optionsChanged =
            currentOptions?.length !== nextOptions?.length ||
            (currentOptions ?? []).some((value, index) => value !== nextOptions?.[index])
          if (optionsChanged) {
            param.enumOptions = nextOptions
            changed = true
          }
        }
        // Defensive: strip enumOptions if param.type !== 'enum' (no-op via the if check)
      }
      return changed
    })
  },

  convertNodeToComponent(nodeId, name) {
    const { activeDocument, activePageId, site } = get()

    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    // 1. Pre-validate name (mirrors renameVisualComponent pattern)
    const nameValidation = validateComponentName(name, site.visualComponents ?? [])
    if (!nameValidation.ok) {
      throw new VisualComponentNameError(nameValidation.reason, nameValidation.error)
    }
    const trimmedName = name.trim()

    // 2. Active document must be a page (null = default page canvas) — VC mode is not allowed
    if (activeDocument?.kind === 'visualComponent') {
      throw new Error('convertNodeToComponent: cannot convert from inside a visual component')
    }
    const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
    if (pageId == null) {
      throw new Error('convertNodeToComponent: no page is active in the editor')
    }

    const page = (site.pages ?? []).find((p) => p.id === pageId)
    if (!page) {
      throw new Error(`convertNodeToComponent: page "${pageId}" not found`)
    }

    const sourceNode = page.nodes[nodeId]
    if (!sourceNode) {
      throw new Error(`convertNodeToComponent: node "${nodeId}" not found on page "${pageId}"`)
    }

    // 3. Reject re-wrapping a ref or root
    if (sourceNode.moduleId === 'base.visual-component-ref') {
      throw new Error('convertNodeToComponent: cannot convert a base.visual-component-ref node')
    }
    if (sourceNode.moduleId === 'base.body') {
      throw new Error('convertNodeToComponent: cannot convert a base.body node')
    }

    // 4. Data integrity check: all VCs referenced in the subtree must exist
    const vcRefs = collectVCRefsFromPageSubtree(page.nodes, nodeId)
    for (const vcRefId of vcRefs) {
      const refExists = (site.visualComponents ?? []).some((v) => v.id === vcRefId)
      if (!refExists) {
        throw new VisualComponentRecursionError(
          `Subtree references missing Visual Component "${vcRefId}" — data integrity error.`,
        )
      }
    }

    // newVcId is captured here so the producer can return it via closure
    let newVcId = ''

    mutateSiteState((state, site) => {
        const draftPage = (site.pages ?? []).find((p) => p.id === pageId)
        if (!draftPage) return false

        // 5a. Generate the new VC id
        newVcId = nanoid()

        // 5b. Deep-clone the subtree from the page's flat nodes into a flat VCNode tree.
        // hoistedClassIds accumulates node-scoped class IDs that should be declared
        // at the new VC level (scope.nodeId is rewritten inside the helper).
        const idMap = new Map<string, string>()
        const hoistedClassIds = new Set<string>()
        const clonedTree = clonePageSubtreeToFlatNodes(
          draftPage.nodes,
          nodeId,
          site.styleRules,
          idMap,
          hoistedClassIds,
        )

        // 5c. Always wrap the cloned source in a `base.body` root.
        //
        // INVARIANT: every NodeTree in this codebase — page trees, VC trees,
        // future slot fragments — has `base.body` as its root. Pages enforce
        // this by construction; `createVisualComponent` enforces it for new
        // VCs; this branch enforces it for VCs created by componentizing
        // existing page subtrees.
        //
        // The user-facing benefit: always-the-same shape. No "did the source
        // happen to be a container?" branching in callers, no special cases
        // in `useInsertModule`'s parent resolution. `base.body` is transparent
        // at publish time (its render emits naked children HTML, no `<div>`),
        // so the wrapper doesn't add HTML clutter — it's purely a structural
        // anchor inside the editor.
        //
        // Pre-existing behaviour: if the user componentized a single
        // non-container node (Text, Button), the cloned root was that node;
        // `canHaveChildren: false` made the VC unusable for adding siblings,
        // and the toolbar silently corrupted the tree by inserting into the
        // non-container. Always-wrapping eliminates that class of bug entirely.
        const wrapperId = nanoid()
        const wrapperNode: VCNode = {
          id: wrapperId,
          moduleId: 'base.body',
          props: {},
          breakpointOverrides: {},
          children: [clonedTree.rootNodeId],
          classIds: [],
        }
        clonedTree.nodes[wrapperId] = wrapperNode
        clonedTree.rootNodeId = wrapperId
        // Derive parentId across the freshly assembled VC tree (clone + wrapper).
        reindexNodeParents(clonedTree.nodes)

        // 5d. Build the new VisualComponent
        const newVc: VisualComponent = {
          id: newVcId,
          name: trimmedName,
          tree: clonedTree,
          params: [],
          classIds: [...hoistedClassIds],
          createdAt: Date.now(),
        }
        site.visualComponents.push(newVc)

        // 5e. Find the parent of the source node in the page
        let parentNode: PageNode | undefined
        for (const pNode of Object.values(draftPage.nodes)) {
          if (pNode.children.includes(nodeId)) {
            parentNode = pNode
            break
          }
        }

        if (!parentNode) {
          // nodeId has no parent — it is the page body; cannot convert
          throw new Error('convertNodeToComponent: cannot convert page body')
        }

        // Replace source nodeId with the new VC-ref node id in the parent's children
        const childIdx = parentNode.children.indexOf(nodeId)
        const refNodeId = nanoid()
        parentNode.children[childIdx] = refNodeId

        // Create the base.visual-component-ref page node
        draftPage.nodes[refNodeId] = {
          id: refNodeId,
          moduleId: 'base.visual-component-ref',
          props: { componentId: newVcId, propOverrides: {} },
          breakpointOverrides: {},
          children: [],
          classIds: [],
        }

        // Delete the original subtree from page.nodes (remove all descended nodes)
        const subtreeIds = collectSubtreeNodeIds(draftPage.nodes, nodeId)
        for (const oldId of subtreeIds) {
          delete draftPage.nodes[oldId]
        }

        // 5f. Switch activeDocument to the new VC; clear selection
        state.activeDocument = { kind: 'visualComponent', vcId: newVcId }
        state.selectedNodeId = null
        return true
      })

    return newVcId
  },
  }
}
