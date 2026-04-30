import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Page, PageNode } from '../page-tree/types'
import type { VisualComponent } from '../visualComponents/types'
import type { ProjectSlice } from './slices/projectSlice'
import type { SelectionSlice } from './slices/selectionSlice'
import type { CanvasSlice } from './slices/canvasSlice'
import type { UiSlice } from './slices/uiSlice'
import type { ClassSlice } from './slices/classSlice'
import type { FilesSlice } from './slices/filesSlice'
import type { VisualComponentsSlice } from './slices/visualComponentsSlice'
import type { SettingsSlice } from './slices/settingsSlice'
import type { AgentSlice } from '../agent/agentSlice'
import type { ProjectPanelSlice } from './slices/projectPanelSlice'
import type { DataModelSlice } from './slices/dataModelSlice'
import { createProjectSlice } from './slices/projectSlice'
import { createSelectionSlice } from './slices/selectionSlice'
import { createCanvasSlice } from './slices/canvasSlice'
import { createUiSlice } from './slices/uiSlice'
import { createClassSlice } from './slices/classSlice'
import { createFilesSlice } from './slices/filesSlice'
import { createVisualComponentsSlice } from './slices/visualComponentsSlice'
import { createSettingsSlice } from './slices/settingsSlice'
import { createAgentSlice } from '../agent/agentSlice'
import { createProjectPanelSlice } from './slices/projectPanelSlice'
import { createDataModelSlice } from './slices/dataModelSlice'

/**
 * EditorStore — the central Zustand store for the page builder editor.
 *
 * Composed of 11 slices (6 canonical Phase 0 + agentSlice + projectPanelSlice + filesSlice + visualComponentsSlice + dataModelSlice):
 *   - projectSlice:        owns Project (pages, nodes, breakpoints, settings, classes, files)
 *   - selectionSlice:      selectedNodeId, hoveredNodeId
 *   - canvasSlice:         zoom, pan, activeBreakpointId, canvasMode (Constraint #317)
 *   - uiSlice:             panel visibility, unsaved-changes flag, insert picker
 *   - classSlice:          CSS class CRUD + node↔class assignment (Phase C)
 *   - filesSlice:          ProjectFile CRUD (Contribution #595 / Task #429)
 *   - visualComponentsSlice: VisualComponent CRUD (Contribution #619 / Task #436)
 *   - settingsSlice:       settings modal open/close + active section (Guideline #193/#323)
 *   - agentSlice:          AI Agent Panel state + streaming (Phase D)
 *   - projectPanelSlice:   Project Panel open/tab/packageJson/lastReactExport (Phase E+)
 *
 * All mutations are wrapped in Immer for structural sharing.
 * Use subscribeWithSelector for granular Zustand subscriptions without Context re-renders.
 *
 * Constraint #182: The page tree is the single source of truth.
 * No panel may maintain a local copy of node data.
 * Constraint #283/#286: No Anthropic SDK imports in this file or any src/ file.
 */
export type EditorStore = ProjectSlice & SelectionSlice & CanvasSlice & UiSlice & ClassSlice & FilesSlice & VisualComponentsSlice & SettingsSlice & AgentSlice & ProjectPanelSlice & DataModelSlice

export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector(
    immer((...args) => ({
      ...createProjectSlice(...args),
      ...createSelectionSlice(...args),
      ...createCanvasSlice(...args),
      ...createUiSlice(...args),
      ...createClassSlice(...args),
      ...createFilesSlice(...args),
      ...createVisualComponentsSlice(...args),
      ...createSettingsSlice(...args),
      ...createAgentSlice(...args),
      ...createProjectPanelSlice(...args),
      ...createDataModelSlice(...args),
    }))
  )
)

// ---------------------------------------------------------------------------
// Convenience typed selectors — use these instead of accessing store directly
// to keep component subscriptions granular and avoid unnecessary re-renders.
// ---------------------------------------------------------------------------

/** Select the active page from the project */
export const selectActivePage = (s: EditorStore) =>
  s.project?.pages.find((p) => p.id === s.activePageId) ?? null

/** Select whether the docked right sidebar is currently taking layout space. */
export const selectRightSidebarExpanded = (s: EditorStore) =>
  s.propertiesPanelMode === 'docked' &&
  !s.propertiesPanel.collapsed &&
  Boolean(s.selectedNodeId)

// ---------------------------------------------------------------------------
// selectActiveCanvasPage — VC-aware canvas page selector (Task #438)
//
// When activeDocument is a VC, builds a virtual Page from the VC's rootNode
// tree so NodeRenderer + BreakpointFrame work unchanged.
//
// Memoised via WeakMap keyed on vc (the whole VC object) — Immer gives a new
// ref on ANY field change (name, filePath, params, rootNode…), so the WeakMap
// misses precisely when the VC changes and we rebuild.  Same-reference vc → cache hit.
// ---------------------------------------------------------------------------

/** @internal — module-level WeakMap for stable virtual-page references */
const _vcVirtualPageCache = new WeakMap<object, Page>()

/**
 * Flatten a VC's nested rootNode tree into a flat PageNode dict.
 * Uses the same PageNode shape as Pages (childNodes are iterated recursively).
 */
function _flattenVCToVirtualPage(vc: VisualComponent): Page {
  const nodes: Record<string, PageNode> = {}

  function visit(node: PageNode) {
    nodes[node.id] = node
    if (node.childNodes) {
      for (const child of node.childNodes) {
        visit(child)
      }
    }
  }

  visit(vc.rootNode as unknown as PageNode)

  return {
    id: `vc-virtual:${vc.id}`,
    title: vc.name,
    slug: `components/${vc.name}`,
    rootNodeId: vc.rootNode.id,
    nodes,
  }
}

/**
 * Select the current canvas document as a Page.
 *
 * - activeDocument === null or kind === 'page': returns the active page (same as selectActivePage).
 * - activeDocument.kind === 'visualComponent': returns a virtual Page built from the VC's rootNode.
 *   The virtual Page is memoised via WeakMap on vc (the whole VC object) so Zustand's Object.is
 *   check passes between renders when the VC has not mutated.
 */
export const selectActiveCanvasPage = (s: EditorStore): Page | null => {
  const { activeDocument } = s

  if (!activeDocument || activeDocument.kind === 'page') {
    return selectActivePage(s)
  }

  if (activeDocument.kind === 'visualComponent') {
    const vc = s.project?.visualComponents?.find(
      (v) => v.id === activeDocument.vcId,
    ) ?? null
    if (!vc) return null

    // WeakMap key: vc object — Immer gives a new ref on ANY field change (name, filePath,
    // params, rootNode…). Keying on vc.rootNode would miss renames because Immer reuses
    // rootNode when only top-level VC fields change (O-2 / CR #666 finding).
    const cached = _vcVirtualPageCache.get(vc as object)
    if (cached) return cached

    const virtualPage = _flattenVCToVirtualPage(vc)
    _vcVirtualPageCache.set(vc as object, virtualPage)
    return virtualPage
  }

  return null
}

/**
 * Select the currently selected PageNode.
 *
 * Uses selectActiveCanvasPage so this works in BOTH page mode and VC canvas mode.
 * Without this, PropertiesPanel + SelectionOverlay return null when a node is
 * selected inside a VC tree (O-1 / CR #666 finding — promoted to MUST-FIX).
 */
export const selectSelectedNode = (s: EditorStore) => {
  if (!s.selectedNodeId) return null
  return selectActiveCanvasPage(s)?.nodes[s.selectedNodeId] ?? null
}

/**
 * Select the hovered PageNode.
 *
 * Uses selectActiveCanvasPage for the same reason as selectSelectedNode — hover
 * feedback (SelectionOverlay) must work inside VC trees (O-1 / CR #666).
 */
export const selectHoveredNode = (s: EditorStore) => {
  if (!s.hoveredNodeId) return null
  return selectActiveCanvasPage(s)?.nodes[s.hoveredNodeId] ?? null
}

// ---------------------------------------------------------------------------
// Undo / Redo hooks — subscribe only to the flags, not the full project,
// so toolbar buttons re-render only when availability changes.
// ---------------------------------------------------------------------------

/** React hook: returns the undo action. Stable reference (Zustand action). */
export const useUndo = () => useEditorStore((s) => s.undo)

/** React hook: returns the redo action. Stable reference (Zustand action). */
export const useRedo = () => useEditorStore((s) => s.redo)

/** React hook: true when undo is available. */
export const useCanUndo = () => useEditorStore((s) => s.canUndo)

/** React hook: true when redo is available. */
export const useCanRedo = () => useEditorStore((s) => s.canRedo)
