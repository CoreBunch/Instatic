/**
 * usePropertiesPanelData — single store-binding + derivation hook for the
 * Properties Panel. Owns every editor-store subscription, every derived value
 * (active VC, active class, override keys, enclosing-loop chain, dynamic-
 * binding context) and the breakpoint-aware change handlers. PropertiesPanel
 * itself reads one bundle and renders JSX — no logic.
 *
 * Why a single bundle: the panel function previously juggled 18 separate
 * `useEditorStore(...)` calls plus a dozen derivations, which pushed its
 * cyclomatic + cognitive complexity into the hotspot top-five. Moving all of
 * that into a dedicated hook drops the panel's own complexity to single
 * digits and gives every future "add another derived prop / store field"
 * change a single place to land.
 */
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useEditorStore, selectSelectedNode } from '@site/store/store'
import { registry } from '@core/module-engine'
import { getAncestors, resolveProps } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import { buildClassTokenUsageMap, buildSelectorUsageMap, resolveSelectorUsage } from '../selectorUsage'
import type {
  AnyModuleDefinition,
} from '@core/module-engine'
import type {
  StyleRule,
  DynamicPropBinding,
  Page,
  PageNode,
} from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { LoopEntitySource } from '@core/loops/types'
import type { ActiveDocument, PanelState, FocusedPanel, PropertiesPanelMode } from '../../store/slices/uiSlice'

const DEFAULT_WIDTH = 360
const MIN_WIDTH = 280

/**
 * Everything PropertiesPanel needs to render. Field order intentionally
 * mirrors the panel's render flow (selection → context → module data → class
 * data → loop context → panel chrome → actions) to make it cheap to scan.
 */
interface PropertiesPanelData {
  // ─── Selection ─────────────────────────────────────────────────────────
  selectedNode: PageNode | null
  selectedNodeId: string | null
  selectedNodeIds: string[]
  isMultiSelect: boolean

  // ─── Canvas context ────────────────────────────────────────────────────
  activeDocument: ActiveDocument | null
  activeVc: VisualComponent | null
  activePage: Page | null
  activeBreakpointId: string | undefined

  // ─── Module + props ────────────────────────────────────────────────────
  definition: AnyModuleDefinition | null
  resolvedPropsForBreakpoint: Record<string, unknown> | null
  overrideKeys: Set<string>

  // ─── Class context ─────────────────────────────────────────────────────
  activeClass: StyleRule | null
  activeClassId: string | null
  selectedSelectorClass: StyleRule | null
  selectedSelectorClassId: string | null
  selectedSelectorClassIds: string[]
  isSelectorMultiSelect: boolean
  selectedSelectorUsage: string | null

  // ─── Loop / dynamic-binding context ────────────────────────────────────
  enclosingLoopSource: LoopEntitySource | undefined
  enclosingLoopTableId: string | null
  dynamicBindingsEnabled: boolean

  // ─── Panel chrome state ────────────────────────────────────────────────
  panelState: PanelState
  collapsed: boolean
  width: number
  focusedPanel: FocusedPanel
  statusMessage: string

  // ─── Panel chrome actions ──────────────────────────────────────────────
  setStatusMessage: (msg: string) => void
  togglePropertiesPanel: () => void
  setPropertiesPanelMode: (mode: PropertiesPanelMode) => void
  setFocusedPanel: (panel: FocusedPanel) => void
  renameClass: (classId: string, name: string) => void
  deleteClass: (classId: string) => void
  renameNode: (nodeId: string, label: string) => void

  // ─── Prop change handlers ──────────────────────────────────────────────
  handleChange: (propKey: string, value: unknown) => void
  handlePatch: (patch: Record<string, unknown>) => void
  handleSetDynamicBinding: (propKey: string, binding: DynamicPropBinding) => void
  handleClearDynamicBinding: (propKey: string) => void
}

export function usePropertiesPanelData(): PropertiesPanelData {
  // ─── Store subscriptions ────────────────────────────────────────────────
  const selectedNode = useEditorStore(selectSelectedNode)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectedNodeIds = useEditorStore(useShallow((s) => s.selectedNodeIds))
  const updateNodeProps = useEditorStore((s) => s.updateNodeProps)
  const setNodeDynamicBinding = useEditorStore((s) => s.setNodeDynamicBinding)
  const clearNodeDynamicBinding = useEditorStore((s) => s.clearNodeDynamicBinding)
  const setBreakpointOverride = useEditorStore((s) => s.setBreakpointOverride)
  const renameClass = useEditorStore((s) => s.renameClass)
  const deleteClass = useEditorStore((s) => s.deleteClass)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const renameNode = useEditorStore((s) => s.renameNode)
  const site = useEditorStore((s) => s.site)
  const activePageId = useEditorStore((s) => s.activePageId)
  const activeClassId = useEditorStore((s) => s.activeClassId)
  const selectedSelectorClassId = useEditorStore((s) => s.selectedSelectorClassId)
  const selectedSelectorClassIds = useEditorStore(useShallow((s) => s.selectedSelectorClassIds))
  const panelState = useEditorStore((s) => s.propertiesPanel)
  const setPropertiesPanelMode = useEditorStore((s) => s.setPropertiesPanelMode)
  const togglePropertiesPanel = useEditorStore((s) => s.togglePropertiesPanel)
  const focusedPanel = useEditorStore((s) => s.focusedPanel)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const activeDocument = useEditorStore((s) => s.activeDocument)

  const [statusMessage, setStatusMessage] = useState('')

  // ─── Derivations ────────────────────────────────────────────────────────
  const isMultiSelect = selectedNodeIds.length > 1
  const isSelectorMultiSelect = selectedSelectorClassIds.length > 0

  // Resolve active VC for ComponentParamsOverview (null when not in VC canvas mode).
  const activeVc = activeDocument?.kind === 'visualComponent'
    ? site?.visualComponents?.find((v) => v.id === activeDocument.vcId) ?? null
    : null

  const definition: AnyModuleDefinition | null = selectedNode
    ? registry.get(selectedNode.moduleId) ?? null
    : null
  const resolvedPropsForBreakpoint = selectedNode
    ? resolveProps(
        selectedNode,
        activeBreakpointId !== 'desktop' ? activeBreakpointId : undefined,
        definition?.schema,
      )
    : null

  // Only props the module marks `breakpointOverridable: true` may carry a
  // per-breakpoint override; everything else is content (single value across
  // all breakpoints). Filter the override-indicator set the same way so the
  // UI never claims a content prop has a per-breakpoint variant — even if
  // stale data on disk technically does.
  const overrideKeys = resolveOverrideKeys(selectedNode, definition, activeBreakpointId)

  const selectedSelectorClass = selectedSelectorClassId
    ? site?.styleRules[selectedSelectorClassId] ?? null
    : null
  // Ambient rules report "Unused" only when provably dead; class rules report
  // an exact reference count. `null` means "no badge" (unassessable ambient).
  const selectorUsageById = buildSelectorUsageMap(site)
  const selectedSelectorUsage = selectedSelectorClass
    ? resolveSelectorUsage(
        selectedSelectorClass,
        selectorUsageById,
        buildClassTokenUsageMap(site?.styleRules ?? {}, selectorUsageById),
      ).label
    : null
  const activeClass =
    !selectedSelectorClass && activeClassId && selectedNode
      ? site?.styleRules[activeClassId] ?? null
      : null
  const activePage = site?.pages.find((page) => page.id === activePageId) ?? null

  // Dynamic bindings are available whenever the selected node sits inside a
  // scope that produces a `currentEntry` at render time:
  //   - on a single-entry template page (the page itself injects an entry), OR
  //   - inside a `base.loop` subtree (the loop pushes an iteration item per render).
  // For nodes with a `base.loop` ancestor we expose the same `currentEntry`
  // bindings — they resolve to the loop's iteration item via the publisher's
  // entry-stack semantics.
  const { enclosingLoopSource, enclosingLoopTableId } = resolveEnclosingLoopContext(
    activePage,
    selectedNodeId,
  )
  // Bindings are always available. The picker decides which sources are
  // meaningful in the current context (`currentEntry` / `parentEntry`
  // only when inside a loop or template page; page / site / route
  // are always offered). Phase 3 of the binding system refactor —
  // see docs/superpowers/plans/2026-05-… for the broader plan.
  const dynamicBindingsEnabled = true

  // ─── Prop change handler ────────────────────────────────────────────────
  //
  // A non-default breakpoint frame routes writes through
  // `setBreakpointOverride` ONLY when the module schema marks the prop
  // `breakpointOverridable: true`. For everything else (the default — content
  // props like text, tag, src, alt) the edit always lands on base props,
  // because the published page is one HTML document and content cannot
  // meaningfully differ per viewport. Visual responsive variation lives in
  // class breakpoint styles, not in module props.
  //
  // The schema lookup is intentionally performed via `registry.get()` inside
  // the handler rather than closing over the `definition` object, so it always
  // reflects the current selection without depending on a recomputed value.
  const moduleId = selectedNode?.moduleId
  const handleChange = (propKey: string, value: unknown) => {
    if (!selectedNodeId) return
    const def = moduleId ? registry.get(moduleId) : null
    const isOverridable = def?.schema[propKey]?.breakpointOverridable === true
    if (activeBreakpointId && activeBreakpointId !== 'desktop' && isOverridable) {
      setBreakpointOverride(selectedNodeId, activeBreakpointId, { [propKey]: value })
    } else {
      updateNodeProps(selectedNodeId, { [propKey]: value })
    }
    setStatusMessage(`${propKey} updated`)
  }

  const handlePatch = (patch: Record<string, unknown>) => {
    if (!selectedNodeId) return
    updateNodeProps(selectedNodeId, patch)
    setStatusMessage('Form settings updated')
  }

  const handleSetDynamicBinding = (propKey: string, binding: DynamicPropBinding) => {
    if (!selectedNodeId) return
    setNodeDynamicBinding(selectedNodeId, propKey, binding)
    setStatusMessage(`${propKey} bound`)
  }

  const handleClearDynamicBinding = (propKey: string) => {
    if (!selectedNodeId) return
    clearNodeDynamicBinding(selectedNodeId, propKey)
    setStatusMessage(`${propKey} binding removed`)
  }

  const collapsed = panelState.collapsed
  const width = Math.max(panelState.width || DEFAULT_WIDTH, MIN_WIDTH)

  return {
    selectedNode,
    selectedNodeId,
    selectedNodeIds,
    isMultiSelect,

    activeDocument,
    activeVc,
    activePage,
    activeBreakpointId,

    definition,
    resolvedPropsForBreakpoint,
    overrideKeys,

    activeClass,
    activeClassId,
    selectedSelectorClass,
    selectedSelectorClassId,
    selectedSelectorClassIds,
    isSelectorMultiSelect,
    selectedSelectorUsage,

    enclosingLoopSource,
    enclosingLoopTableId,
    dynamicBindingsEnabled,

    panelState,
    collapsed,
    width,
    focusedPanel,
    statusMessage,

    setStatusMessage,
    togglePropertiesPanel,
    setPropertiesPanelMode,
    setFocusedPanel,
    renameClass,
    deleteClass,
    renameNode,

    handleChange,
    handlePatch,
    handleSetDynamicBinding,
    handleClearDynamicBinding,
  }
}

// ---------------------------------------------------------------------------
// Helpers — pulled out so the hook body stays readable. Each helper has one
// reason to change.
// ---------------------------------------------------------------------------

function resolveOverrideKeys(
  selectedNode: PageNode | null,
  definition: AnyModuleDefinition | null,
  activeBreakpointId: string | undefined,
): Set<string> {
  if (!selectedNode || !definition || !activeBreakpointId || activeBreakpointId === 'desktop') {
    return new Set()
  }
  const overrides = selectedNode.breakpointOverrides[activeBreakpointId] ?? {}
  return new Set(
    Object.keys(overrides).filter(
      (key) => definition.schema[key]?.breakpointOverridable === true,
    ),
  )
}

interface EnclosingLoopContext {
  enclosingLoopSource: LoopEntitySource | undefined
  enclosingLoopTableId: string | null
}

function resolveEnclosingLoopContext(
  activePage: Page | null,
  selectedNodeId: string | null,
): EnclosingLoopContext {
  if (!activePage || !selectedNodeId) {
    return { enclosingLoopSource: undefined, enclosingLoopTableId: null }
  }

  const ancestors = getAncestors(activePage, selectedNodeId)
  // Closest enclosing loop wins — that's the one whose source defines the
  // available fields for `currentEntry` bindings inside this subtree.
  const enclosingLoopNode = [...ancestors]
    .reverse()
    .find((a) => a.moduleId === 'base.loop')

  if (!enclosingLoopNode) {
    return { enclosingLoopSource: undefined, enclosingLoopTableId: null }
  }

  const enclosingLoopSourceId = typeof enclosingLoopNode.props.sourceId === 'string'
    ? enclosingLoopNode.props.sourceId
    : null
  const enclosingLoopSource = enclosingLoopSourceId
    ? loopSourceRegistry.get(enclosingLoopSourceId)
    : undefined

  return {
    enclosingLoopSource,
    enclosingLoopTableId: extractLoopTableId(enclosingLoopNode, enclosingLoopSourceId),
  }
}

// Loop bound to a specific data table — pass its tableId down so the binding
// picker can auto-scope to that table (the only one the loop will iterate),
// instead of offering every table in the workspace.
function extractLoopTableId(
  enclosingLoopNode: PageNode,
  enclosingLoopSourceId: string | null,
): string | null {
  if (enclosingLoopSourceId !== 'data.rows') return null
  const filters = enclosingLoopNode.props.filters
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null
  const tableId = (filters as Record<string, unknown>).tableId
  return typeof tableId === 'string' && tableId ? tableId : null
}
