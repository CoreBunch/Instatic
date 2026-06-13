/**
 * Node mutation actions for the active document tree.
 *
 * The 11 named tree-mutation actions (`insertNode`, `deleteNode`,
 * `updateNodeProps`, `setBreakpointOverride`, `clearBreakpointOverride`,
 * `renameNode`, `toggleNodeLocked`, `toggleNodeHidden`, `moveNode`,
 * `duplicateNode`, `wrapNode`) all delegate to `mutateActiveTree(fn)` and
 * MUST NOT contain their own `kind === 'visualComponent'` branch — that
 * routing is the sole job of `mutateActiveTree`. Gated by
 * `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 */

import { nanoid } from 'nanoid'
import { registry } from '@core/module-engine'

import {
  cloneScopedClassesForNodeMap,
  createNode,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNode,
  moveNodes,
  duplicateNode,
  wrapNode,
  wrapNodes,
  reindexNodeParents,
} from '@core/page-tree'
import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'
import { subtreeHasOutlet, treeHasOutlet } from '@core/templates'
import { wouldCreateCycle, syncSlotInstances, applySlotSyncResult } from '@core/visualComponents'
import { pushToast } from '@ui/components/Toast'
import { depthInTree, resolveActiveTreeTarget } from './helpers'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import { indexStyleRulesByName, linkImportedClassNames, mergeImportedStyleRules } from './importLinking'
import type { SiteSlice, SiteSliceHelpers } from './types'

type NodeActions = Pick<
  SiteSlice,
  | 'insertNode'
  | 'insertComponentRef'
  | 'insertImportedNodes'
  | 'deleteNode'
  | 'deleteNodes'
  | 'updateNodeProps'
  | 'setNodeInlineStyles'
  | 'removeNodeInlineStyleProperty'
  | 'clearNodeInlineStyles'
  | 'setBreakpointOverride'
  | 'clearBreakpointOverride'
  | 'renameNode'
  | 'toggleNodeLocked'
  | 'toggleNodeHidden'
  | 'moveNode'
  | 'moveNodes'
  | 'duplicateNode'
  | 'duplicateNodes'
  | 'wrapNode'
  | 'wrapNodes'
  | 'setNodeDynamicBinding'
  | 'clearNodeDynamicBinding'
>

/**
 * Build the oldId → newId map for the entire subtree rooted at `nodeId`.
 * Pre-computed so callers can clone scoped classes (which key on
 * `scope.nodeId`) against the same id remap that the duplicate mutation will
 * apply to the nodes themselves.
 */
function buildSubtreeIdMap(
  tree: NodeTree<PageNode>,
  nodeId: string,
): Map<string, string> {
  const idMap = new Map<string, string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (idMap.has(id)) continue
    const node = tree.nodes[id]
    if (!node) continue
    idMap.set(id, nanoid())
    stack.push(...node.children)
  }
  return idMap
}

/**
 * Duplicate a node subtree AND clone every per-node scoped class owned by the
 * subtree. Mirrors the contract used by `clipboardSlice.pasteNode` and
 * `visualComponentsSlice.clonePageSubtreeToFlatNodes` so the publisher can
 * never end up with two nodes pointing at the same scoped class — see F-0005.
 *
 * Must run inside an Immer producer (mutates `tree` and `site` directly).
 */
function duplicateNodeWithScopedClasses(
  tree: NodeTree<PageNode>,
  site: SiteDocument,
  nodeId: string,
): string {
  const nodeIdMap = buildSubtreeIdMap(tree, nodeId)
  if (nodeIdMap.size === 0) return ''

  const { added, classIdRemap } = cloneScopedClassesForNodeMap(nodeIdMap, site.styleRules)
  for (const cls of added) site.styleRules[cls.id] = cls

  return duplicateNode(tree, nodeId, { nodeIdMap, classIdRemap })
}

function recordPatchChanges(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  return Object.entries(patch).some(([key, value]) => !Object.is(current[key], value))
}

/**
 * Surface a blocked one-outlet-per-document mutation to the user. The store is
 * the chokepoint every mutation path runs through (picker, drag-drop, context
 * menus, keyboard shortcuts, spotlight, agent), so the feedback lives here too
 * — the toast bus is explicitly designed for store-side producers.
 */
function toastOutletBlocked(body: string): void {
  pushToast({
    kind: 'warning',
    title: 'Only one content outlet',
    body,
    location: 'site-editor',
  })
}

/**
 * Build the history-coalescing options for a single-field patch, or `undefined`
 * for multi-field patches (which always get their own discrete undo entry).
 *
 * Per-keystroke text/number controls patch exactly one prop per change, so a
 * stable `<scope>:<nodeId>:<prop>` key lets `pushHistorySnapshot` fold a whole
 * typing burst into one undo step instead of cloning the site per character.
 */
function coalesceKeyForPatch(
  scope: string,
  nodeId: string,
  patch: Record<string, unknown>,
): { coalesceKey: string } | undefined {
  const keys = Object.keys(patch)
  if (keys.length !== 1) return undefined
  return { coalesceKey: `${scope}:${nodeId}:${keys[0]}` }
}

export function createNodeActions(helpers: SiteSliceHelpers): NodeActions {
  const { get, set, mutateActiveTree, mutateActiveTreeAndSite } = helpers

  const actions: NodeActions = {
    insertNode: (moduleId, defaults, parentId, index) => {
      const mod = registry.get(moduleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const newNode = createNode(moduleId, resolvedDefaults)
      let inserted = false
      let blockedByOutlet = false
      mutateActiveTree((tree) => {
        // Structural invariant: a document tree holds AT MOST ONE base.outlet.
        // Matched content (a page or the current entry body) flows into a single
        // outlet — both the publisher's `composeTemplateChain` and the canvas's
        // read-only wrapper fill only the first, leaving any extra outlet to
        // render as a dead, empty placeholder. This is the mutation chokepoint
        // every insert path runs through (picker, drag-drop, programmatic), so
        // blocking the second outlet here keeps the invariant no matter the
        // caller. `duplicateNode(s)` and `pasteNode` carry the same guard.
        if (moduleId === 'base.outlet' && treeHasOutlet(tree)) {
          blockedByOutlet = true
          return false
        }
        insertNode(tree, newNode, parentId, index)
        inserted = true
        return true
      })
      if (blockedByOutlet) {
        toastOutletBlocked(
          'This document already has a content outlet — matched content can flow into just one.',
        )
      }
      return inserted ? newNode.id : ''
    },

    insertImportedNodes: (parentId, fragment, opts) => {
      if (fragment.rootIds.length === 0) return []
      const insertedRootIds: string[] = []
      mutateActiveTreeAndSite((tree, site) => {
        const parent = tree.nodes[parentId]
        if (!parent) return false
        const isRoot = tree.rootNodeId === parentId
        const definition = registry.get(parent.moduleId)
        const acceptsChildren = isRoot || definition?.canHaveChildren === true
        if (!acceptsChildren) return false

        // The HTML importer stamps class *names* onto each fragment node's
        // classIds (`walkAndMap` copies el.classList verbatim). The engine
        // keys classes by id and resolves styles by id, so link every imported
        // name to a real registry class — reusing an existing same-named class
        // or auto-creating a bare one — as the nodes enter the live tree.
        // Without this step the names never resolve and styles never apply.
        //
        // Nodes already carry fresh nanoid IDs from createNode — no collision
        // risk on the node map.
        const classesByName = indexStyleRulesByName(site.styleRules)

        // Commit rules parsed from <style> blocks BEFORE linking class names so
        // a node's `class="foo"` token binds to the just-added `.foo {}` rule
        // (rather than auto-creating a bare class). These show in the Selectors
        // panel like any other rule.
        if (opts?.styleRules?.length) {
          mergeImportedStyleRules(opts.styleRules, site.styleRules, classesByName)
        }
        // Register any reusable conditions (custom @media / @container /
        // @supports) the <style> rules reference via contextStyles keys.
        if (opts?.conditions?.length) {
          if (!site.conditions) site.conditions = []
          const existing = new Set(site.conditions.map((c) => c.id))
          for (const def of opts.conditions) {
            if (existing.has(def.id)) continue
            existing.add(def.id)
            site.conditions.push(def)
          }
        }

        for (const [id, node] of Object.entries(fragment.nodes)) {
          // `node.inlineStyles` (imported inline `style="…"`) rides along on
          // the `...node` spread — it is a first-class node field.
          tree.nodes[id] = {
            ...node,
            classIds: linkImportedClassNames(node.classIds, site.styleRules, classesByName),
          }
        }

        // Wire the imported root nodes as children of the target parent.
        const insertAt = opts?.index ?? parent.children.length
        parent.children.splice(insertAt, 0, ...fragment.rootIds)
        insertedRootIds.push(...fragment.rootIds)
        // The fragment was bulk-merged into tree.nodes (not via insertNode), so
        // derive the parentId index across the active tree to keep the inserted
        // subtree's pointers consistent. Deliberately O(active-tree), not a
        // targeted O(fragment) update: import is an infrequent path, and a full
        // reindex is the simplest bulletproof way to stay consistent.
        reindexNodeParents(tree.nodes)
        return true
      })
      return insertedRootIds
    },

    insertComponentRef: (parentId, componentId, index) => {
      if (!componentId) return null

      const { activeDocument, site } = get()

      // In VC mode, guard against cyclic component references before insertion.
      if (activeDocument?.kind === 'visualComponent' && site) {
        if (wouldCreateCycle(site.visualComponents, activeDocument.vcId, componentId)) {
          console.warn('[component-system] cycle prevented by recursion guard')
          return null
        }
      }

      // Resolve the referenced VC up-front (read-only) so its slot-instance
      // children can be materialized in the SAME mutation as the ref insertion.
      const vc = site?.visualComponents.find((v) => v.id === componentId)

      // Build the ref node with the module's registry defaults plus the
      // ref-specific props. `index` forwards to insertNode so callers using
      // resolveInsertLocation can drop the ref at a precise sibling position.
      const mod = registry.get('base.visual-component-ref')
      const newNode = createNode('base.visual-component-ref', {
        ...(mod?.defaults ?? {}),
        componentId,
        propOverrides: {},
      })

      // Insert the VC ref AND materialize its slot-instance children inside ONE
      // mutateActiveTree recipe, so both writes land in a single patch set →
      // a single undo entry. (Splitting them — ref via insertNode, slots via a
      // separate set() outside history — meant Cmd+Z reverted only the ref and
      // left the slot-instance nodes orphaned in the persisted node map forever.)
      const inserted = mutateActiveTree((tree) => {
        insertNode(tree, newNode, parentId, index)
        if (vc) {
          const vcRefNode = tree.nodes[newNode.id]
          if (vcRefNode) {
            const syncResult = syncSlotInstances(vcRefNode, vc, tree.nodes)
            applySlotSyncResult(tree.nodes, syncResult, newNode.id)
          }
        }
        return true
      })

      return inserted ? newNode.id : null
    },

    deleteNode: (nodeId) => {
      const deleted = mutateActiveTree((tree) => {
        if (!tree.nodes[nodeId]) return false
        deleteNode(tree, nodeId)
        return true
      })
      // Drop the deleted node (and any descendants swept with it) from the
      // canvas selection so no phantom selection ring survives. Pruning by
      // tree-membership also clears `selectedNodeIds`, not just the anchor.
      if (deleted) {
        set((state) => { pruneCanvasSelectionDraft(state) })
      }
    },

    updateNodeProps: (nodeId, patch) => {
      mutateActiveTree(
        (tree) => {
          const node = tree.nodes[nodeId]
          if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
          if (!recordPatchChanges(node.props, patch)) return false
          updateNodeProps(tree, nodeId, patch)
          return true
        },
        coalesceKeyForPatch('props', nodeId, patch),
      )
    },

    setNodeInlineStyles: (nodeId, patch) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        const next: Record<string, unknown> = { ...(node.inlineStyles ?? {}) }
        let changed = false
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value === undefined || value === '') {
            if (key in next) {
              delete next[key]
              changed = true
            }
          } else if (!Object.is(next[key], value)) {
            next[key] = value
            changed = true
          }
        }
        if (!changed) return false
        // Drop the field entirely when the bag is empty so nodes without inline
        // styles stay lean (and the publisher emits no `style` attribute).
        if (Object.keys(next).length > 0) node.inlineStyles = next
        else delete node.inlineStyles
        return true
      })
    },

    removeNodeInlineStyleProperty: (nodeId, propKey) => {
      actions.setNodeInlineStyles(nodeId, { [propKey]: null })
    },

    clearNodeInlineStyles: (nodeId) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.inlineStyles) return false
        delete node.inlineStyles
        return true
      })
    },

    setBreakpointOverride: (nodeId, breakpointId, patch) => {
      mutateActiveTree(
        (tree) => {
          const node = tree.nodes[nodeId]
          if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
          if (!recordPatchChanges(node.breakpointOverrides[breakpointId] ?? {}, patch)) {
            return false
          }
          setBreakpointOverride(tree, nodeId, breakpointId, patch)
          return true
        },
        coalesceKeyForPatch(`bp:${breakpointId}`, nodeId, patch),
      )
    },

    clearBreakpointOverride: (nodeId, breakpointId) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.breakpointOverrides[breakpointId]) return false
        clearBreakpointOverride(tree, nodeId, breakpointId)
        return true
      })
    },

    renameNode: (nodeId, label) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        const nextLabel = label.trim() || undefined
        if (node.label === nextLabel) return false
        renameNode(tree, nodeId, label)
        return true
      })
    },

    toggleNodeLocked: (nodeId) => {
      mutateActiveTree((tree) => {
        toggleNodeLocked(tree, nodeId)
        return true
      })
    },

    toggleNodeHidden: (nodeId) => {
      mutateActiveTree((tree) => {
        toggleNodeHidden(tree, nodeId)
        return true
      })
    },

    moveNode: (nodeId, newParentId, newIndex) => {
      mutateActiveTree((tree) => {
        moveNode(tree, nodeId, newParentId, newIndex)
        return true
      })
    },

    moveNodes: (nodeIds, newParentId, newIndex) => {
      if (nodeIds.length === 0) return
      mutateActiveTree((tree) => {
        moveNodes(tree, nodeIds, newParentId, newIndex)
        return true
      })
    },

    duplicateNode: (nodeId) => {
      let newId = ''
      let blockedByOutlet = false
      // Per-node "module-style" classes (scope.type === 'node') must be cloned
      // alongside the node — otherwise the duplicate's classIds carry the
      // source's class id and editing one node restyles both. F-0005.
      mutateActiveTreeAndSite((tree, site) => {
        if (!tree.nodes[nodeId]) return false
        // One-outlet-per-document invariant: the source subtree still holds the
        // outlet, so duplicating it would mint a second one.
        if (subtreeHasOutlet(tree.nodes, nodeId)) {
          blockedByOutlet = true
          return false
        }
        newId = duplicateNodeWithScopedClasses(tree, site, nodeId)
        return newId ? true : false
      })
      if (blockedByOutlet) {
        toastOutletBlocked(
          'Duplicating this would create a second content outlet — a document can hold just one.',
        )
      }
      return newId
    },

    duplicateNodes: (nodeIds) => {
      if (nodeIds.length === 0) return []
      const newIds: string[] = []
      let blockedByOutlet = false
      mutateActiveTreeAndSite((tree, site) => {
        for (const id of nodeIds) {
          // Skip the root and any id missing from the tree — duplicateNode
          // throws on the root, and silently skipping orphans matches the
          // delete/move guards.
          if (!tree.nodes[id] || id === tree.rootNodeId) continue
          // One-outlet-per-document invariant — same guard as duplicateNode.
          if (subtreeHasOutlet(tree.nodes, id)) {
            blockedByOutlet = true
            continue
          }
          newIds.push(duplicateNodeWithScopedClasses(tree, site, id))
        }
        return newIds.length > 0
      })
      if (blockedByOutlet) {
        toastOutletBlocked(
          'Duplicating the content outlet was skipped — a document can hold just one.',
        )
      }
      return newIds
    },

    deleteNodes: (nodeIds) => {
      if (nodeIds.length === 0) return
      // Precompute depths ONCE against the FROZEN pre-mutation tree: sorting
      // inside the recipe would walk ancestor chains through the Mutative
      // draft (every node access materializes a draft proxy), twice per
      // comparison. Sorting against pre-draft state is safe because the
      // recipe re-checks `tree.nodes[id]` before each delete.
      const target = resolveActiveTreeTarget(get())
      if (!target) return
      const depthById = new Map<string, number>()
      for (const id of nodeIds) depthById.set(id, depthInTree(target.tree, id))
      // Sort by depth-DESC so leaves go first — descendants of an
      // already-deleted id are gone, and the "node not found" guard handles
      // the redundant case cleanly.
      const ordered = [...nodeIds].sort(
        (a, b) => depthById.get(b)! - depthById.get(a)!,
      )
      const deleted = mutateActiveTree((tree) => {
        let changed = false
        for (const id of ordered) {
          if (id === tree.rootNodeId) continue
          if (!tree.nodes[id]) continue
          deleteNode(tree, id)
          changed = true
        }
        return changed
      })
      // Same selection cleanup as `deleteNode`: drop every deleted id (and any
      // descendants) so the multi-selection array doesn't keep phantom ids.
      if (deleted) {
        set((state) => { pruneCanvasSelectionDraft(state) })
      }
    },

    wrapNode: (nodeId, containerModuleId, defaults = {}) => {
      // Auto-resolve the module's schema defaults so the wrapper node renders correctly.
      // Without this, wrapNode(id, 'base.container') produces props:{} → props.tag=undefined
      // → React.createElement(undefined) → "Element type is invalid" crash (Task #414).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId = ''
      mutateActiveTree((tree) => {
        wrapperId = wrapNode(tree, nodeId, containerModuleId, resolvedDefaults)
        return true
      })
      return wrapperId
    },

    wrapNodes: (nodeIds, containerModuleId, defaults = {}) => {
      if (nodeIds.length === 0) return null
      // Same defaults-resolution rule as `wrapNode` (Task #414 — defaults must
      // come from the module registry so the wrapper renders).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId: string | null = null
      mutateActiveTree((tree) => {
        wrapperId = wrapNodes(tree, nodeIds, containerModuleId, resolvedDefaults)
        return true
      })
      return wrapperId
    },

    setNodeDynamicBinding: (nodeId, propKey, binding) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) return false
        const current = node.dynamicBindings?.[propKey]
        if (
          current &&
          current.source === binding.source &&
          current.field === binding.field &&
          current.format === binding.format &&
          current.fallback === binding.fallback
        ) {
          return false
        }
        node.dynamicBindings = {
          ...(node.dynamicBindings ?? {}),
          [propKey]: binding,
        }
        return true
      })
    },

    clearNodeDynamicBinding: (nodeId, propKey) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.dynamicBindings?.[propKey]) return false
        delete node.dynamicBindings[propKey]
        if (Object.keys(node.dynamicBindings).length === 0) {
          delete node.dynamicBindings
        }
        return true
      })
    },
  }

  return actions
}
