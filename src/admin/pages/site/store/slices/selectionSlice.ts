import type { Draft } from 'mutative'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { isUserVisibleClass } from '@core/page-tree'
import type { BaseNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'
import { flattenSubtree, getParent } from '@core/page-tree'

/**
 * Selection mode for `selectNode`:
 * - `replace` (default) — clear current selection and select only `id`
 * - `toggle` — Cmd/Ctrl-click semantics: add `id` if absent, remove if present
 * - `range` — Shift-click semantics: select every node from current anchor to
 *   `id` along the active tree's depth-first walk order. Cross-parent ranges
 *   are allowed (matches Figma).
 */
export type SelectionMode = 'replace' | 'toggle' | 'range'

export interface SelectionSlice {
  /**
   * The full multi-selection set, ordered. The LAST entry is the "anchor"
   * (= `selectedNodeId`). Empty array when nothing is selected.
   */
  selectedNodeIds: string[]
  /**
   * Anchor of the multi-selection — the most recently added node. Mirrors
   * `selectedNodeIds[selectedNodeIds.length - 1] ?? null`. Most call sites
   * (Properties panel header, drag origin, agent context) want this single
   * value; multi-aware sites (per-row `isSelected`, multi-actions) read
   * `selectedNodeIds` instead.
   */
  selectedNodeId: string | null
  /** Hovered node ID — null if no hover */
  hoveredNodeId: string | null
  /** Breakpoint frame that owns the current canvas hover; null means global hover */
  hoveredBreakpointId: string | null

  /**
   * Select a node.
   * - `replace` (default): clears selection, selects only `id`. Pass `null` to clear.
   * - `toggle`: add or remove `id` from the selection set.
   * - `range`: select every node between the current anchor and `id` (DFS order).
   *
   * Modifier-aware callers pass `mode` based on `e.metaKey || e.ctrlKey` (toggle)
   * or `e.shiftKey` (range).
   */
  selectNode: (id: string | null, mode?: SelectionMode) => void
  /** Replace the current selection with the given set. */
  selectMany: (ids: string[]) => void
  /** Add a node to the selection set (no-op if already present). */
  addToSelection: (id: string) => void
  /** Remove a node from the selection set (no-op if absent). */
  removeFromSelection: (id: string) => void
  hoverNode: (id: string | null, breakpointId?: string | null) => void
  clearSelection: () => void
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends SelectionSlice {}
}

export const createSelectionSlice: EditorStoreSliceCreator<SelectionSlice> = (set, get) => ({
  selectedNodeIds: [],
  selectedNodeId: null,
  hoveredNodeId: null,
  hoveredBreakpointId: null,

  selectNode: (id, mode = 'replace') => {
    const current = get()

    // Clearing — only valid in 'replace' mode (toggle/range need a target id).
    if (id === null) {
      if (current.selectedNodeIds.length === 0) return
      const shouldCollapseProperties = !current.selectedSelectorClassId
      set((state) => {
        state.selectedNodeIds = []
        state.selectedNodeId = null
        state.activeClassId = null
        state.inlineStyleEditing = false
        state.propertiesPanel.collapsed = shouldCollapseProperties
      })
      return
    }

    // Compute the next selection set based on mode.
    let nextIds: string[]

    if (mode === 'toggle') {
      const filtered = filterMultiSelectableIds(current, [id])
      if (filtered.length === 0) {
        // Toggle target rejected (root, locked slot-instance, cross-tree) →
        // fall back to replace-select (matches Figma: cmd-click on root selects it).
        nextIds = [id]
      } else if (current.selectedNodeIds.includes(id)) {
        nextIds = current.selectedNodeIds.filter((existing) => existing !== id)
      } else {
        // Adding to an existing selection: enforce same-tree by clearing the
        // selection if the new id is from a different tree than the anchor.
        nextIds = sameTree(current, current.selectedNodeIds, id)
          ? [...current.selectedNodeIds, id]
          : [id]
      }
    } else if (mode === 'range') {
      const anchor = current.selectedNodeId
      if (!anchor || anchor === id) {
        nextIds = [id]
      } else {
        const range = computeRangeIds(current, anchor, id)
        if (range.length === 0) {
          nextIds = [id]
        } else {
          // Anchor stays the anchor (last in the list). Place range nodes
          // before it, then push the freshly clicked id last so it becomes
          // the new anchor (matches Figma: shift-click moves the anchor).
          const filtered = filterMultiSelectableIds(current, range).filter(
            (rangeId) => rangeId !== id,
          )
          nextIds = [...filtered, id]
        }
      }
    } else {
      // 'replace'
      nextIds = [id]
    }

    applySelection(set, current, nextIds)
  },

  selectMany: (ids) => {
    const current = get()
    const filtered = filterMultiSelectableIds(current, ids)
    applySelection(set, current, filtered)
  },

  addToSelection: (id) => {
    get().selectNode(id, 'toggle')
    // If toggle removed it, re-add — `addToSelection` is idempotent.
    const after = get()
    if (!after.selectedNodeIds.includes(id)) {
      const next = sameTree(after, after.selectedNodeIds, id)
        ? [...after.selectedNodeIds, id]
        : [id]
      applySelection(set, after, next)
    }
  },

  removeFromSelection: (id) => {
    const current = get()
    if (!current.selectedNodeIds.includes(id)) return
    const next = current.selectedNodeIds.filter((existing) => existing !== id)
    applySelection(set, current, next)
  },

  hoverNode: (id, breakpointId = null) => set({
    hoveredNodeId: id,
    hoveredBreakpointId: id ? breakpointId : null,
  }),

  clearSelection: () => set({
    selectedNodeIds: [],
    selectedNodeId: null,
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    activeClassId: null,
    inlineStyleEditing: false,
    componentizeEditorRequest: null,
  }),
})

// ---------------------------------------------------------------------------
// Mutation helpers for use inside immer producers
// ---------------------------------------------------------------------------

/**
 * Clear canvas selection + hover from an immer draft.
 *
 * Use this from any mutation that switches the active document (page swap,
 * VC mode entry/exit, site reload, node deletion) — anywhere a previously
 * valid selection becomes stale because the underlying nodes either no
 * longer exist in the active tree or live in a different tree entirely.
 *
 * Why a helper exists: `selectedNodeIds` is the source of truth (the
 * `BreakpointSelectionOverlay` subscribes to it via `useShallow`) and
 * `selectedNodeId` is the anchor mirror (= last item of the array). Forgetting
 * to clear the array — a recurring bug — left phantom selection rings on the
 * canvas after every page swap. Funnel all "drop stale selection" paths
 * through this helper so they stay in lock-step.
 */
export function clearCanvasSelectionDraft(state: EditorStore): void {
  state.selectedNodeIds = []
  state.selectedNodeId = null
  state.hoveredNodeId = null
  state.hoveredBreakpointId = null
  state.activeClassId = null
  // A document/page switch invalidates any inline text-edit session — the
  // node it points at is no longer on the canvas. Live keystrokes already
  // committed; clearing here is the spec's "force-close without committing".
  state.activeInlineEdit = null
}

/**
 * Drop only the ids that no longer exist in the active tree, keeping surviving
 * selections intact and re-syncing the `selectedNodeId` anchor (= last item of
 * the array).
 *
 * Use after a node deletion. Unlike `clearCanvasSelectionDraft` (which drops
 * the whole selection), this preserves still-valid selections and removes just
 * the deleted nodes — including descendants swept away with a deleted subtree,
 * since those are pruned by tree-membership, not by id list. This is what stops
 * a context-menu delete from leaving a phantom selection ring on the canvas.
 */
export function pruneCanvasSelectionDraft(state: EditorStore): void {
  const tree = getActiveTree(state)
  // Inline edit prunes by tree-membership too — the edited node may be a
  // descendant swept away with a deleted subtree, and it may not be part of
  // the selection at all, so this must run before the early return below.
  if (state.activeInlineEdit && !tree?.nodes[state.activeInlineEdit.nodeId]) {
    state.activeInlineEdit = null
  }
  const surviving = tree
    ? state.selectedNodeIds.filter((id) => Boolean(tree.nodes[id]))
    : []
  if (surviving.length === state.selectedNodeIds.length) return
  state.selectedNodeIds = surviving
  state.selectedNodeId = surviving.length > 0 ? surviving[surviving.length - 1] : null
  if (surviving.length === 0) {
    state.hoveredNodeId = null
    state.hoveredBreakpointId = null
    state.activeClassId = null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a fully-resolved next-selection set to the store. Handles:
 * - syncing `selectedNodeId` (= last item of `selectedNodeIds`)
 * - deriving `activeClassId` from the new anchor (preserving the existing
 *   class if the anchor still has it assigned)
 * - collapsing the Properties panel iff selection becomes empty AND no
 *   selector class is active
 */
function applySelection(
  set: (updater: (state: Draft<EditorStore>) => void) => void,
  current: EditorStore,
  nextIds: string[],
): void {
  const nextAnchor = nextIds.length > 0 ? nextIds[nextIds.length - 1] : null
  const nextActiveClassId = getSelectionActiveClassId(current, nextAnchor)
  // A node with inline styles but no class opens directly in inline-edit mode.
  const nextInlineEditing = nextActiveClassId === null && nodeHasInlineStyles(current, nextAnchor)
  const shouldCollapseProperties = !nextAnchor && !current.selectedSelectorClassId

  const idsChanged = !arraysEqual(current.selectedNodeIds, nextIds)
  const anchorChanged = !Object.is(current.selectedNodeId, nextAnchor)
  // Re-selecting the same node when the panel was manually collapsed must
  // re-open it (matches the J7+J8 user flow). The check is symmetric:
  // collapse on empty selection, expand on any selection — even the same one.
  const panelChanged = !Object.is(
    current.propertiesPanel.collapsed,
    shouldCollapseProperties,
  )
  const activeClassChanged = !Object.is(current.activeClassId, nextActiveClassId)
  const inlineEditingChanged =
    anchorChanged && !Object.is(current.inlineStyleEditing, nextInlineEditing)

  if (!idsChanged && !anchorChanged && !panelChanged && !activeClassChanged && !inlineEditingChanged) return

  set((state) => {
    state.selectedNodeIds = nextIds
    state.selectedNodeId = nextAnchor
    if (nextAnchor) state.selectedSelectorClassId = null
    state.activeClassId = nextActiveClassId
    // Each new selection seeds its own edit target — inline mode for an
    // inline-only node, otherwise class/empty — never carrying a prior node's
    // inline-editing mode across.
    if (anchorChanged) state.inlineStyleEditing = nextInlineEditing
    if (panelChanged) state.propertiesPanel.collapsed = shouldCollapseProperties
    if (current.componentizeEditorRequest?.nodeId !== nextAnchor) {
      state.componentizeEditorRequest = null
    }
  })
}

/**
 * Filter ids to only those that may legally participate in a multi-selection.
 * Rules:
 * - The page/VC tree root cannot be part of a multi-selection (only solo).
 * - A `base.slot-instance` whose parent is a `base.visual-component-ref` is
 *   structural (managed by syncSlotInstances) and may not be multi-selected.
 * - All ids must come from the active document's tree (cross-tree multi-select
 *   is not supported).
 *
 * Returned ids preserve input order.
 */
function filterMultiSelectableIds(state: EditorStore, ids: string[]): string[] {
  const tree = getActiveTree(state)
  if (!tree) return []
  const result: string[] = []
  for (const id of ids) {
    const node = tree.nodes[id]
    if (!node) continue
    if (id === tree.rootNodeId) continue
    if (node.moduleId === 'base.slot-instance') {
      const parent = getParent(tree, id)
      if (parent?.moduleId === 'base.visual-component-ref') continue
    }
    result.push(id)
  }
  return result
}

/**
 * Compute the set of node ids between `anchorId` and `targetId` along the
 * active tree's depth-first pre-order. Inclusive of both endpoints. Returns
 * an empty array when either id is absent from the active tree.
 */
function computeRangeIds(
  state: EditorStore,
  anchorId: string,
  targetId: string,
): string[] {
  const tree = getActiveTree(state)
  if (!tree) return []
  if (!tree.nodes[anchorId] || !tree.nodes[targetId]) return []

  const flat = flattenSubtree(tree, tree.rootNodeId)
  const a = flat.indexOf(anchorId)
  const b = flat.indexOf(targetId)
  if (a === -1 || b === -1) return []
  const [start, end] = a <= b ? [a, b] : [b, a]
  return flat.slice(start, end + 1)
}

/**
 * Whether `id` lives in the same tree as the existing selection. Empty
 * selections are always considered "same tree".
 */
function sameTree(state: EditorStore, existingIds: string[], id: string): boolean {
  if (existingIds.length === 0) return true
  const tree = getActiveTree(state)
  if (!tree) return false
  if (!tree.nodes[id]) return false
  // Spot-check: the existing anchor must also live in this tree. If not, the
  // selection is stale (active document changed) and we should refuse.
  const anchor = existingIds[existingIds.length - 1]
  return Boolean(tree.nodes[anchor])
}

/**
 * Resolve the active tree (page or VC) without going through the store-level
 * `selectActiveCanvasPage` selector. Importing that selector would create a
 * `selectionSlice ↔ store` cycle. The returned shape is `NodeTree<PageNode>`
 * so the slice's helpers can use the page-tree selectors uniformly.
 * Also consumed by `inlineEditSlice` (same no-cycle rationale).
 */
export function getActiveTree(state: EditorStore): NodeTree<PageNode> | null {
  if (!state.site) return null
  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const vc = state.site.visualComponents?.find((v) => v.id === activeDocument.vcId)
    return vc ? (vc.tree as NodeTree<PageNode>) : null
  }
  const page = state.site.pages.find((p) => p.id === state.activePageId)
  return page ?? null
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function getSelectionActiveClassId(state: EditorStore, nodeId: string | null): string | null {
  if (!nodeId) return null

  const node = findSelectableNode(state, nodeId)
  if (!node?.classIds?.length || !state.site) return null

  const visibleClassIds = node.classIds.filter((classId) => {
    const cls = state.site?.styleRules[classId]
    return cls && isUserVisibleClass(cls)
  })

  if (visibleClassIds.length === 0) return null
  if (state.activeClassId && visibleClassIds.includes(state.activeClassId)) {
    return state.activeClassId
  }
  return visibleClassIds[0]
}

/**
 * Whether a node carries inline styles. Used to seed `inlineStyleEditing` on
 * selection so a node with inline styles but no class opens straight into the
 * inline-style editor (the flag is then the single source of truth for which
 * target the Properties panel edits).
 */
function nodeHasInlineStyles(state: EditorStore, nodeId: string | null): boolean {
  if (!nodeId) return false
  const node = findSelectableNode(state, nodeId)
  const inline = (node as { inlineStyles?: Record<string, unknown> } | null)?.inlineStyles
  return !!inline && Object.keys(inline).length > 0
}

function findSelectableNode(state: EditorStore, nodeId: string): BaseNode | null {
  if (!state.site) return null

  const activeDocument = state.activeDocument
  if (activeDocument?.kind === 'visualComponent') {
    const component = state.site.visualComponents?.find((vc) => vc.id === activeDocument.vcId)
    if (component) {
      const node = component.tree.nodes[nodeId]
      if (node) return node
    }
  }

  for (const page of state.site.pages) {
    const node = page.nodes[nodeId]
    if (node) return node
  }

  return null
}
