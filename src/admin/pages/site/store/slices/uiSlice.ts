import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import { clearCanvasSelectionDraft } from './selectionSlice'

export type FocusedPanel = 'canvas' | 'domTree' | 'properties' | null
type FormPreviewState = 'default' | 'submitting' | 'success' | 'error'
export type LeftSidebarPanelId =
  | 'site'
  | 'selectors'
  | 'colors'
  | 'typography'
  | 'spacing'
  | 'media'
  | 'dependencies'
  | 'layers'
  | 'agent'
export type PropertiesPanelMode = 'docked' | 'floating'

export const SIDEBAR_MIN_WIDTH = 300
export const SIDEBAR_MAX_WIDTH = 520
export const LEFT_SIDEBAR_DEFAULT_WIDTH = 320
const PROPERTIES_PANEL_DEFAULT_WIDTH = 360

/**
 * Active document descriptor — tracks which canvas document is open.
 * 'page' → standard page canvas; 'visualComponent' → VC canvas mode (Task #438).
 * Architecture source: Contribution #631 §5 (single-active-doc pattern).
 */
export type ActiveDocument =
  | { kind: 'page'; pageId: string }
  | { kind: 'visualComponent'; vcId: string }

export interface PanelState {
  collapsed: boolean
  x: number
  y: number
  width: number
}

/**
 * A non-file code buffer opened in the CodeEditor panel — currently a single
 * string prop on a page node (e.g. the inline-SVG markup on a `base.svg`).
 * The editor reads the node's current prop value and writes edits back via
 * `updateNodeProps(nodeId, { [propKey]: content })`, so no callback needs to
 * live in store state.
 */
interface PropCodeBuffer {
  nodeId: string
  propKey: string
  /** Panel title, e.g. "Edit SVG". */
  title: string
  /** Highlighting language for the buffer. */
  language: 'html' | 'css' | 'json' | 'ts' | 'tsx' | 'markdown' | 'text'
}

interface ComponentizeEditorRequest {
  nodeId: string
  requestId: number
}

/**
 * Pending layout naming flow rendered by `LayoutNameDialog`:
 *   - `create` — capture `nodeId` + its subtree as a new saved layout.
 *   - `rename` — rename the existing saved layout `layoutId`.
 */
export type LayoutNameDialogRequest =
  | { mode: 'create'; nodeId: string }
  | { mode: 'rename'; layoutId: string }


interface UiSlice {
  // Panel visibility / layout
  domTreePanel: PanelState
  propertiesPanel: PanelState
  propertiesPanelMode: PropertiesPanelMode
  leftSidebarWidth: number
  focusedPanel: FocusedPanel

  // Settings modal state lives in `settingsSlice` (single source of truth) —
  // it used to be duplicated here as `settingsModalOpen` / `settingsModalSection`
  // but the duplication was vestigial. Use `state.isSettingsOpen` /
  // `state.activeSection` / `state.openSettings` / `state.closeSettings`.

  // Preview overlay — toggle from toolbar (Phase 7)
  previewOpen: boolean

  // Editor-only form state preview, keyed by base.form node id.
  formPreviewStates: Record<string, FormPreviewState>

  // Module insert picker
  insertPickerOpen: boolean
  insertPickerParentId: string | null

  // Inline Visual Component extraction editor in the Properties panel.
  componentizeEditorRequest: ComponentizeEditorRequest | null

  /**
   * Pending layout naming flow — `create` captures the node's subtree as a
   * new saved layout, `rename` renames an existing one. Rendered by
   * `LayoutNameDialog` (mounted once in the editor body).
   */
  layoutNameDialogRequest: LayoutNameDialogRequest | null

  // Site explorer — user-facing site concepts, not generated source files
  siteExplorerPanelOpen: boolean
  selectorsPanelOpen: boolean
  colorsPanelOpen: boolean
  typographyPanelOpen: boolean
  spacingPanelOpen: boolean
  mediaExplorerPanelOpen: boolean
  dependenciesPanelOpen: boolean

  /**
   * Plugin-registered editor panel currently open in the left sidebar, or
   * `null` when a built-in panel (or nothing) is active. Mutually exclusive
   * with the built-in `*PanelOpen` flags — the setters below clear the
   * other side automatically. The id is the full panel id registered by the
   * plugin (e.g. `acme.workflow.review`); the host looks it up in
   * `pluginRuntime.getPanel(id)` at render time.
   */
  activePluginPanelId: string | null

  // CodeEditorPanel (Task #433) — whether the code editor floating panel is visible
  codeEditorPanelOpen: boolean

  // CodeEditor (Task #432) — ID of the file currently open in the code editor
  activeEditorFileId: string | null

  // Non-file code buffer (e.g. an inline-SVG node prop) open in the editor.
  // Mutually exclusive with activeEditorFileId.
  activeCodeBuffer: PropCodeBuffer | null

  // Actions
  setDomTreePanel: (state: Partial<PanelState>) => void
  setPropertiesPanel: (state: Partial<PanelState>) => void
  setPropertiesPanelMode: (mode: PropertiesPanelMode) => void
  setLeftSidebarWidth: (width: number) => void
  toggleDomTreePanel: () => void
  togglePropertiesPanel: () => void
  setFocusedPanel: (panel: FocusedPanel) => void
  cycleFocusedPanel: () => void


  openPreview: () => void
  closePreview: () => void
  setFormPreviewState: (formNodeId: string, state: FormPreviewState) => void

  openInsertPicker: (parentId: string) => void
  closeInsertPicker: () => void
  openComponentizeEditor: (nodeId: string) => void
  clearComponentizeEditorRequest: (requestId: number) => void
  openLayoutNameDialog: (request: LayoutNameDialogRequest) => void
  closeLayoutNameDialog: () => void

  setSiteExplorerPanelOpen: (open: boolean) => void
  setSelectorsPanelOpen: (open: boolean) => void
  setColorsPanelOpen: (open: boolean) => void
  setTypographyPanelOpen: (open: boolean) => void
  setSpacingPanelOpen: (open: boolean) => void
  setMediaExplorerPanelOpen: (open: boolean) => void
  setDependenciesPanelOpen: (open: boolean) => void
  setLeftSidebarPanel: (panel: LeftSidebarPanelId | null) => void
  toggleLeftSidebarPanel: (panel: LeftSidebarPanelId) => void

  /**
   * Open a plugin-registered panel by id. Clears all built-in panels (only
   * one panel can be active at a time). Pass `null` to close the active
   * plugin panel without opening anything else.
   */
  setActivePluginPanel: (panelId: string | null) => void
  /** Toggle a plugin panel — open if not active, close if active. */
  toggleActivePluginPanel: (panelId: string) => void

  /** Show / hide the CodeEditor floating panel. */
  setCodeEditorPanelOpen: (open: boolean) => void

  /** Open a SiteFile in the CodeEditor panel. Sets activeEditorFileId and auto-shows the panel. */
  openInEditor: (fileId: string) => void
  /** Open a node-prop code buffer (e.g. inline SVG) in the CodeEditor panel. */
  openPropInEditor: (buffer: PropCodeBuffer) => void
  /** Clear activeEditorFileId and hide the panel (e.g. when the file is deleted or editor closed). */
  closeEditor: () => void

  /**
   * Active canvas document — set when switching between page canvas and VC canvas mode.
   * Null = no explicit canvas document selected (default page canvas applies).
   */
  activeDocument: ActiveDocument | null
  setActiveDocument: (doc: ActiveDocument | null) => void

  /**
   * Exit VC canvas mode and return to the previously active page.
   *
   * - Sets activeDocument = null.
   * - If previousActivePageId is set and its page still exists in the site,
   *   restores activePageId to that page; otherwise leaves activePageId as-is.
   * - Clears selectedNodeId and previousActivePageId.
   */
  exitVisualComponentMode: () => void

  /**
   * Session-only preview source per template page (templateId → source id):
   * the page id whose content fills an `everywhere` template's outlet, or the
   * row id whose entry drives a `postTypes` template's `currentEntry`. A pure
   * preview convenience — never persisted to the site document. Unset → the
   * first real page / published row is previewed.
   */
  templatePreviewSelection: Record<string, string>
  /** Set (or clear, with `null`) the previewed source for a template page. */
  setTemplatePreviewSelection: (templateId: string, sourceId: string | null) => void

  /** Class selected in the global Selectors panel. */
  selectedSelectorClassId: string | null
  setSelectedSelectorClassId: (classId: string | null) => void

  /**
   * Style rule whose selector is currently hovered in the Selectors panel.
   * Drives the orange selector-affinity rings on the canvas — every element
   * matching this rule's selector gets a ring, the panel-side analogue of the
   * DOM tree's hover highlight. Null when nothing is hovered.
   */
  highlightedSelectorClassId: string | null
  setHighlightedSelectorClassId: (classId: string | null) => void

  /**
   * Multi-selection set built from the Selectors panel row checkboxes. When
   * non-empty the Properties panel shows the bulk MultiSelectorInspector
   * instead of a single selector / node inspector. Mutually exclusive with the
   * single `selectedSelectorClassId` — entering one clears the other.
   */
  selectedSelectorClassIds: string[]
  /** Add / remove a selector from the multi-selection. Clears single-select. */
  toggleSelectorMultiSelect: (classId: string) => void
  /** Replace the whole multi-selection set. Clears single-select when non-empty. */
  setSelectedSelectorClassIds: (classIds: string[]) => void
  /** Clear the selector multi-selection. */
  clearSelectorMultiSelect: () => void

  /**
   * Atomically open a page in the canvas and clear any active VC document.
   * Use this instead of calling setActivePage + setActiveDocument separately to
   * avoid intermediate states where activeDocument is still 'visualComponent'
   * while activePageId has already changed (SF-2 / CR #666 finding).
   */
  openPageInCanvas: (pageId: string) => void

  /**
   * Whether the Data workspace's left sidebar panel is collapsed (hidden).
   * Mirrors the `propertiesPanel.collapsed` naming convention. When true,
   * the panel slot shrinks to zero-width but the rail indicator remains.
   */
  dataSidebarCollapsed: boolean
  setDataSidebarCollapsed: (collapsed: boolean) => void

  // ─── Import HTML modal ───────────────────────────────────────────────────────
  /** Whether the Import HTML modal is currently open. */
  importHtmlModalOpen: boolean
  /** Node id of the parent to insert under, or null to use the page root. */
  importHtmlModalParentId: string | null
  /** HTML pre-filled into the textarea when the modal opens. */
  importHtmlModalPrefill: string
  /** Open the Import HTML modal, optionally targeting a specific parent node
   *  and pre-filling the textarea from the clipboard or a snippet. */
  openImportHtmlModal: (opts?: { parentId?: string; prefillHtml?: string }) => void
  /** Close the Import HTML modal and clear its transient state. */
  closeImportHtmlModal: () => void

}

const PANEL_FOCUS_ORDER: FocusedPanel[] = ['canvas', 'domTree', 'properties']

const DEFAULT_DOM_TREE_PANEL: PanelState = {
  collapsed: false,
  x: 0,
  y: 0,
  width: 280,
}

const DEFAULT_PROPERTIES_PANEL: PanelState = {
  collapsed: false,
  x: 0, // will be set to window.innerWidth - width on mount
  y: 0,
  width: PROPERTIES_PANEL_DEFAULT_WIDTH,
}

export function clampSidebarWidth(width: number) {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(width)))
}

function getActiveLeftSidebarPanel(state: EditorStore): LeftSidebarPanelId | null {
  // A plugin panel takes precedence over every built-in panel — the
  // built-in `*PanelOpen` flags are forced to false whenever a plugin
  // panel is opened, but `domTreePanel.collapsed` defaults to false so
  // we have to short-circuit here too.
  if (state.activePluginPanelId !== null) return null
  if (state.siteExplorerPanelOpen) return 'site'
  if (state.selectorsPanelOpen) return 'selectors'
  if (state.colorsPanelOpen) return 'colors'
  if (state.typographyPanelOpen) return 'typography'
  if (state.spacingPanelOpen) return 'spacing'
  if (state.mediaExplorerPanelOpen) return 'media'
  if (state.dependenciesPanelOpen) return 'dependencies'
  if (!state.domTreePanel.collapsed) return 'layers'
  if (state.isAgentOpen) return 'agent'
  return null
}

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends UiSlice {}
}

export const createUiSlice: EditorStoreSliceCreator<UiSlice> = (set, get) => ({
  domTreePanel: DEFAULT_DOM_TREE_PANEL,
  propertiesPanel: DEFAULT_PROPERTIES_PANEL,
  propertiesPanelMode: 'docked',
  leftSidebarWidth: LEFT_SIDEBAR_DEFAULT_WIDTH,
  focusedPanel: 'canvas',
  previewOpen: false,
  formPreviewStates: {},
  insertPickerOpen: false,
  insertPickerParentId: null,
  componentizeEditorRequest: null,
  layoutNameDialogRequest: null,
  siteExplorerPanelOpen: false,
  selectorsPanelOpen: false,
  colorsPanelOpen: false,
  typographyPanelOpen: false,
  spacingPanelOpen: false,
  mediaExplorerPanelOpen: false,
  dependenciesPanelOpen: false,
  activePluginPanelId: null,
  codeEditorPanelOpen: false,
  activeEditorFileId: null,
  activeCodeBuffer: null,
  activeDocument: null,
  templatePreviewSelection: {},
  selectedSelectorClassId: null,
  highlightedSelectorClassId: null,
  selectedSelectorClassIds: [],
  dataSidebarCollapsed: false,
  importHtmlModalOpen: false,
  importHtmlModalParentId: null,
  importHtmlModalPrefill: '',

  setDomTreePanel: (partial) => {
    // Guard: skip the set() call entirely when every supplied field already
    // matches the current value.  A no-op spread like
    //   set((s) => ({ domTreePanel: { ...s.domTreePanel, ...partial } }))
    // still produces a new object reference, which triggers
    // useSyncExternalStore's tearing detection and schedules a synchronous
    // forceStoreRerender.  On initial mount DomPanel calls this from its
    // localStorage-restore effect — if the stored value equals the default,
    // the guard prevents the spurious mutation that was causing the
    // "Maximum update depth exceeded" crash.
    const current = get().domTreePanel
    const anyChanged = (Object.keys(partial) as (keyof PanelState)[]).some(
      (k) => !Object.is(current[k], partial[k]),
    )
    if (!anyChanged) return
    set((state) => {
      state.domTreePanel = { ...state.domTreePanel, ...partial }
    })
  },

  setPropertiesPanel: (partial) => {
    // Same guard as setDomTreePanel — prevents a no-op mutation from
    // PropertiesPanel's localStorage-restore effect on initial mount.
    const current = get().propertiesPanel
    const anyChanged = (Object.keys(partial) as (keyof PanelState)[]).some(
      (k) => !Object.is(current[k], partial[k]),
    )
    if (!anyChanged) return
    set((state) => {
      state.propertiesPanel = { ...state.propertiesPanel, ...partial }
    })
  },

  setPropertiesPanelMode: (mode) => {
    if (Object.is(get().propertiesPanelMode, mode)) return
    set({ propertiesPanelMode: mode })
  },

  setLeftSidebarWidth: (width) => {
    const nextWidth = clampSidebarWidth(width)
    if (Object.is(get().leftSidebarWidth, nextWidth)) return
    set({ leftSidebarWidth: nextWidth })
  },

  toggleDomTreePanel: () =>
    set((state) => {
      state.domTreePanel.collapsed = !state.domTreePanel.collapsed
    }),

  togglePropertiesPanel: () =>
    set((state) => {
      state.propertiesPanel.collapsed = state.propertiesPanel.collapsed
        ? !state.selectedNodeId
        : true
    }),

  setFocusedPanel: (panel) => set({ focusedPanel: panel }),

  cycleFocusedPanel: () => {
    const { focusedPanel } = get()
    const idx = PANEL_FOCUS_ORDER.indexOf(focusedPanel)
    const next = PANEL_FOCUS_ORDER[(idx + 1) % PANEL_FOCUS_ORDER.length]
    set({ focusedPanel: next })
  },

  openPreview: () => set({ previewOpen: true }),
  closePreview: () => set({ previewOpen: false }),

  setFormPreviewState: (formNodeId, previewState) =>
    set((state) => {
      if (previewState === 'default') {
        delete state.formPreviewStates[formNodeId]
        return
      }
      state.formPreviewStates[formNodeId] = previewState
    }),

  openInsertPicker: (parentId) =>
    set({ insertPickerOpen: true, insertPickerParentId: parentId }),

  closeInsertPicker: () =>
    set({ insertPickerOpen: false, insertPickerParentId: null }),

  openComponentizeEditor: (nodeId) => {
    const current = get()
    if (current.selectedNodeId !== nodeId || current.selectedNodeIds.length !== 1) {
      current.selectNode(nodeId)
    }
    set((state) => {
      state.selectedSelectorClassId = null
      state.selectedSelectorClassIds = []
      state.propertiesPanel = { ...state.propertiesPanel, collapsed: false }
      state.focusedPanel = 'properties'
      state.componentizeEditorRequest = {
        nodeId,
        requestId: (state.componentizeEditorRequest?.requestId ?? 0) + 1,
      }
    })
  },

  clearComponentizeEditorRequest: (requestId) => {
    if (get().componentizeEditorRequest?.requestId !== requestId) return
    set({ componentizeEditorRequest: null })
  },

  openLayoutNameDialog: (request) => set({ layoutNameDialogRequest: request }),

  closeLayoutNameDialog: () => set({ layoutNameDialogRequest: null }),

  setSiteExplorerPanelOpen: (open) => set({ siteExplorerPanelOpen: open }),

  setSelectorsPanelOpen: (open) => set({ selectorsPanelOpen: open }),

  setColorsPanelOpen: (open) => set({ colorsPanelOpen: open }),

  setTypographyPanelOpen: (open) => set({ typographyPanelOpen: open }),

  setSpacingPanelOpen: (open) => set({ spacingPanelOpen: open }),

  setMediaExplorerPanelOpen: (open) => set({ mediaExplorerPanelOpen: open }),

  setDependenciesPanelOpen: (open) => set({ dependenciesPanelOpen: open }),

  setLeftSidebarPanel: (panel) =>
    set((state) => {
      state.siteExplorerPanelOpen = panel === 'site'
      state.selectorsPanelOpen = panel === 'selectors'
      state.colorsPanelOpen = panel === 'colors'
      state.typographyPanelOpen = panel === 'typography'
      state.spacingPanelOpen = panel === 'spacing'
      state.mediaExplorerPanelOpen = panel === 'media'
      state.dependenciesPanelOpen = panel === 'dependencies'
      state.domTreePanel.collapsed = panel !== 'layers'
      state.isAgentOpen = panel === 'agent'
      // Built-in panels are mutually exclusive with plugin panels.
      state.activePluginPanelId = null
    }),

  toggleLeftSidebarPanel: (panel) => {
    // Account for the plugin-panel-takes-precedence rule in
    // getActiveLeftSidebarPanel: if a plugin panel is currently active
    // and the user clicks a built-in rail item, that should open the
    // built-in panel (not toggle it closed because it "wasn't active").
    const state = get()
    const activePanel = state.activePluginPanelId === null
      ? getActiveLeftSidebarPanel(state)
      : null
    get().setLeftSidebarPanel(activePanel === panel ? null : panel)
  },

  setActivePluginPanel: (panelId) =>
    set((state) => {
      state.siteExplorerPanelOpen = false
      state.selectorsPanelOpen = false
      state.colorsPanelOpen = false
      state.typographyPanelOpen = false
      state.spacingPanelOpen = false
      state.mediaExplorerPanelOpen = false
      state.dependenciesPanelOpen = false
      state.domTreePanel.collapsed = true
      state.isAgentOpen = false
      state.activePluginPanelId = panelId
    }),

  toggleActivePluginPanel: (panelId) => {
    const current = get().activePluginPanelId
    get().setActivePluginPanel(current === panelId ? null : panelId)
  },

  setCodeEditorPanelOpen: (open) => set({ codeEditorPanelOpen: open }),

  openInEditor: (fileId) =>
    // Auto-show the panel whenever a file is opened (avoids a two-click UX).
    // Clears any prop buffer — file and buffer modes are mutually exclusive.
    set({ activeEditorFileId: fileId, activeCodeBuffer: null, codeEditorPanelOpen: true }),

  openPropInEditor: (buffer) =>
    // Open a node-prop buffer (e.g. inline SVG). Clears the active file.
    set({ activeCodeBuffer: buffer, activeEditorFileId: null, codeEditorPanelOpen: true }),

  closeEditor: () =>
    // Closing the editor hides the panel and clears both file + buffer.
    set({ activeEditorFileId: null, activeCodeBuffer: null, codeEditorPanelOpen: false }),

  setActiveDocument: (doc) =>
    set((state) => {
        const prevDoc = state.activeDocument
        state.activeDocument = doc

        if (doc?.kind === 'visualComponent') {
          // Entering VC mode: capture the page we came from IF the previous
          // activeDocument was null (the default page canvas). Coming from an
          // explicit page doc or another VC → leave previousActivePageId as-is.
          if (prevDoc === null && state.activePageId !== null) {
            state.previousActivePageId = state.activePageId
          }
        } else {
          // Leaving VC mode (setting to null or a page doc) → clear the captured id.
          state.previousActivePageId = null
        }

        // Drop stale selection / hover whenever the active document actually
        // changes. The DOM panel resets to "nothing selected" on a doc switch
        // anyway, and a node ID from the previous document either no longer
        // resolves in the new canvas or — worse — accidentally collides with
        // an unrelated node ID, which makes the selection overlay land in the
        // wrong place. Clearing here is the single source of truth so every
        // entry point (page → VC, VC → page, VC → other VC, doc → null) gets
        // it right.
        if (!isSameActiveDocument(prevDoc, doc)) {
          clearCanvasSelectionDraft(state)
        }
      }),

  exitVisualComponentMode: () =>
    set((state) => {
        const prevPageId = state.previousActivePageId
        state.activeDocument = null
        // Restore the page we came from if it still exists in the site.
        if (prevPageId !== null && state.site?.pages.some((p) => p.id === prevPageId)) {
          state.activePageId = prevPageId
        }
        clearCanvasSelectionDraft(state)
        state.previousActivePageId = null
      }),

  setTemplatePreviewSelection: (templateId, sourceId) =>
    set((state) => {
      if (sourceId === null) {
        delete state.templatePreviewSelection[templateId]
      } else {
        state.templatePreviewSelection[templateId] = sourceId
      }
    }),

  setSelectedSelectorClassId: (classId) => {
    const state = get()
    // Single-select and multi-select are mutually exclusive surfaces. Opening a
    // single selector for editing clears any pending checkbox multi-selection.
    const clearMulti = classId !== null && state.selectedSelectorClassIds.length > 0
    if (Object.is(state.selectedSelectorClassId, classId) && !clearMulti) return
    set(clearMulti
      ? { selectedSelectorClassId: classId, selectedSelectorClassIds: [] }
      : { selectedSelectorClassId: classId })
  },

  setHighlightedSelectorClassId: (classId) => {
    if (Object.is(get().highlightedSelectorClassId, classId)) return
    set({ highlightedSelectorClassId: classId })
  },

  toggleSelectorMultiSelect: (classId) =>
    set((state) => {
      const current = state.selectedSelectorClassIds
      const next = current.includes(classId)
        ? current.filter((id) => id !== classId)
        : [...current, classId]
      state.selectedSelectorClassIds = next
      // Checking a box leaves single-edit mode so the bulk inspector takes over.
      if (next.length > 0) state.selectedSelectorClassId = null
    }),

  setSelectedSelectorClassIds: (classIds) =>
    set((state) => {
      state.selectedSelectorClassIds = classIds
      if (classIds.length > 0) state.selectedSelectorClassId = null
    }),

  clearSelectorMultiSelect: () => {
    if (get().selectedSelectorClassIds.length === 0) return
    set({ selectedSelectorClassIds: [] })
  },

  setDataSidebarCollapsed: (collapsed) => set({ dataSidebarCollapsed: collapsed }),

  openImportHtmlModal: (opts) =>
    set({
      importHtmlModalOpen: true,
      importHtmlModalParentId: opts?.parentId ?? null,
      importHtmlModalPrefill: opts?.prefillHtml ?? '',
    }),

  closeImportHtmlModal: () =>
    set({ importHtmlModalOpen: false, importHtmlModalParentId: null, importHtmlModalPrefill: '' }),

  openPageInCanvas: (pageId) =>
    // Atomic: clear VC mode + switch to the target page in one store write.
    // Avoids an intermediate state where activeDocument is still 'visualComponent'
    // while activePageId has already changed (SF-2 / CR #666 finding).
    //
    // Also drops stale selection / hover when the target page differs from the
    // currently active page. Same rationale as setActiveDocument: a node ID
    // from the previous document either won't resolve in the new canvas or
    // could collide with an unrelated node ID and put the selection overlay
    // in the wrong place.
    set((state) => {
      const docChanged = state.activeDocument !== null
      const pageChanged = state.activePageId !== pageId

      state.activeDocument = null
      state.activePageId = pageId
      state.previousActivePageId = null

      if (docChanged || pageChanged) {
        clearCanvasSelectionDraft(state)
      }
    }),
})

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Compare two ActiveDocument descriptors structurally. Reference equality is
 * not enough — UI call sites typically construct fresh `{ kind, ... }` objects
 * each time, so two semantically-equal documents are usually distinct
 * references. Used by setActiveDocument to decide whether selection / hover
 * needs to be cleared.
 */
function isSameActiveDocument(
  a: ActiveDocument | null,
  b: ActiveDocument | null,
): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'page' && b.kind === 'page') return a.pageId === b.pageId
  if (a.kind === 'visualComponent' && b.kind === 'visualComponent') return a.vcId === b.vcId
  return false
}
