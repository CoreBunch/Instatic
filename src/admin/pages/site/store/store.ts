import { create } from 'zustand'
import { mutative } from 'zustand-mutative'
import { subscribeWithSelector } from 'zustand/middleware'
import type { Page } from '@core/page-tree'
import { flattenVCToVirtualPage } from '@core/visualComponents'
import type { EditorStore } from './types'
import { createSiteSlice } from './slices/siteSlice'
import { createSelectionSlice } from './slices/selectionSlice'
import { createCanvasSlice } from './slices/canvasSlice'
import { createUiSlice } from './slices/uiSlice'
import { createStyleRuleSlice } from './slices/styleRuleSlice'
import { createFilesSlice } from './slices/filesSlice'
import { createVisualComponentsSlice } from './slices/visualComponentsSlice'
import { createSettingsSlice, bindSettingsBridgeStoreApi } from './slices/settingsSlice'
import { createAgentSlice, siteAgentSliceConfig, setAgentStoreApi } from '@site/agent'
import { createSitePanelSlice } from './slices/sitePanelSlice'
import { createClipboardSlice } from './slices/clipboardSlice'
import { bindPluginRuntimeStoreApi } from '@core/plugins/runtime'
import { useAdminUi } from '@admin/state/adminUi'
import { readWorkspaceLayout, workspaceFromPathname } from '@site/layout/panelLayoutStorage'
import { restoreStoredEditorLayout } from '@site/hooks/useEditorLayoutPersistence'

/**
 * EditorStore — the central Zustand store for the visual editor.
 *
 * Composed of 11 slices (6 canonical Phase 0 + agentSlice + sitePanelSlice + filesSlice + visualComponentsSlice + clipboardSlice):
 *   - siteSlice:        owns SiteDocument (pages, nodes, breakpoints, settings, classes, files)
 *   - selectionSlice:      selectedNodeId, hoveredNodeId
 *   - canvasSlice:         zoom, pan, activeBreakpointId, canvasMode (Constraint #317)
 *   - uiSlice:             panel visibility, unsaved-changes flag, insert picker
 *   - styleRuleSlice:      style-rule (class + ambient) CRUD + node↔class assignment
 *   - filesSlice:          SiteFile CRUD (Contribution #595 / Task #429)
 *   - visualComponentsSlice: VisualComponent CRUD (Contribution #619 / Task #436)
 *   - settingsSlice:       settings modal open/close + active section (Guideline #193/#323)
 *   - agentSlice:          AI Agent Panel state + streaming (Phase D)
 *   - sitePanelSlice:      dependency manifest + site runtime settings
 *   - clipboardSlice:      copy / cut / paste of layer subtrees, persisted editor-wide
 *
 * The combined `EditorStore` type lives in `./types` so each slice can import
 * it without going through this module — that's how the historical
 * store ↔ slice cycles were eliminated.
 *
 * All mutations are wrapped in Immer for structural sharing.
 * Use subscribeWithSelector for granular Zustand subscriptions without Context re-renders.
 *
 * Constraint #182: The page tree is the single source of truth.
 * No panel may maintain a local copy of node data.
 * Constraint #283/#286: No Anthropic SDK imports in this file or any src/ file.
 */
export type { EditorStore }

export const useEditorStore = create<EditorStore>()(
  subscribeWithSelector(
    // Mutative replaces Immer (zustand-mutative middleware). enableAutoFreeze
    // mirrors Immer's default dev guard against accidental external mutation —
    // existing code already tolerates frozen state, so we keep it on for parity.
    // Patch-based undo history opts INTO patches per-call via mutative `create`.
    mutative(
      (...args) => ({
        ...createSiteSlice(...args),
        ...createSelectionSlice(...args),
        ...createCanvasSlice(...args),
        ...createUiSlice(...args),
        ...createStyleRuleSlice(...args),
        ...createFilesSlice(...args),
        ...createVisualComponentsSlice(...args),
        ...createSettingsSlice(...args),
        ...createAgentSlice(siteAgentSliceConfig)(...args),
        ...createSitePanelSlice(...args),
        ...createClipboardSlice(...args),
      }),
      { enableAutoFreeze: true },
    )
  )
)

// Synchronously hydrate the persisted editor layout (sidebar widths,
// open/closed panel states) from localStorage at module-load time —
// BEFORE the first React render reads the store. Picks the workspace
// to hydrate from based on the current URL pathname so e.g. opening
// `/admin/media` paints with media's saved sidebar state, not site's.
//
// Why this can't live in a `useEffect`: `useEditorLayoutPersistence`
// used to be the sole hydration site, and `useEffect` only runs after
// the first commit. That meant every cold load painted twice — first
// with the in-memory `uiSlice` defaults (e.g. `propertiesPanel.collapsed
// = false`, `width = 360`), then a moment later with the persisted
// state (e.g. `collapsed = true`, `width = 380`). The right sidebar's
// `transition: width 180ms ease` picked up that delta and slid the
// panel in from the default width — producing the layout shift the
// user reported. Running the hydration synchronously here means the
// very first render already sees the persisted state, so no transition
// fires on cold load.
//
// The hook still runs on every canvas-layout mount as a safety net
// (re-applies the layout when the layout component remounts after a
// non-editor route) and owns the write-side `subscribe`.
if (typeof window !== 'undefined') {
  const initialWorkspace = workspaceFromPathname(window.location.pathname) ?? 'site'
  const initialLayout = readWorkspaceLayout(initialWorkspace)
  restoreStoredEditorLayout(useEditorStore, initialWorkspace, initialLayout)
}

// Wire the live store reference to the agent executor's bridge module so
// `executor.ts` can read/write state without statically importing this file
// (which would re-introduce the executor → store → agentSlice → executor cycle).
setAgentStoreApi(useEditorStore)

// Wire the adminUi ↔ settings bridge in both directions.
//   - `bindSettingsBridgeStoreApi` covers adminUi → editor mirroring so
//     code outside the canvas (SettingsButton in AdminPageLayout) can
//     update the editor's `isSettingsOpen` / `activeSection` without
//     statically importing the editor store.
//   - The `useEditorStore.subscribe` below covers editor → adminUi for
//     code paths that bypass our action wrappers and call `setState`
//     directly (most notably the test fixtures, which set
//     `isSettingsOpen` directly on the store to simulate UI state).
//     Without this, AdminPageLayout's `settingsOpen` gate would miss
//     those direct flips.
bindSettingsBridgeStoreApi(useEditorStore)
// Mirror the canonical settings flag into adminUi so admin-shell layouts
// can subscribe without importing the editor store. This is a one-way
// fan-out: editor → adminUi. The reverse path (admin shell calls
// adminUi.openSettings → mirror back into the editor store) is wired in
// `settingsSlice.bindSettingsBridgeStoreApi` and gated by a re-entrance guard.
useEditorStore.subscribe(
  (state) => ({ open: state.isSettingsOpen, section: state.activeSection }),
  ({ open, section }) => {
    const ui = useAdminUi.getState()
    if (ui.settingsOpen === open && ui.settingsSection === section) return
    if (open) {
      ui.openSettings(section)
    } else {
      ui.closeSettings()
    }
  },
  {
    equalityFn: (a, b) => a.open === b.open && a.section === b.section,
  },
)

// Wire the plugin runtime's editor-store injection so granted plugins
// can call `api.store.read()` / `api.store.transaction()`. The plugin
// runtime intentionally does NOT statically import the editor store
// (that's what made the toolbar's pluginRuntime import drag the store
// into the admin-shell bundle); this binding fills the slot once the
// editor store is constructed.
bindPluginRuntimeStoreApi(useEditorStore)

// ---------------------------------------------------------------------------
// Convenience typed selectors — use these instead of accessing store directly
// to keep component subscriptions granular and avoid unnecessary re-renders.
// ---------------------------------------------------------------------------

// Single-slot memo for the active-page lookup. Zustand re-runs EVERY
// subscriber's selector on every store set, and each canvas NodeRenderer
// mounts several subscriptions that resolve the active page — so an
// unmemoized `pages.find` here costs O(nodes × pages) per store change.
// Keying on (site, activePageId) identity makes the first selector after a
// set pay the O(pages) scan once; every other subscriber in the same sweep
// hits the cache. Mutative copy-on-write replaces `site` exactly when
// anything inside it changes, so invalidation is automatic — and the cached
// page is the same object `find` would return, so subscriber outputs keep
// their referential stability.
let _activePageCache: { site: object; activePageId: string; page: Page | null } | null = null

/** Select the active page from the site (one `pages` scan per store update). */
export const selectActivePage = (s: EditorStore): Page | null => {
  const { site, activePageId } = s
  if (!site || !activePageId) return null
  if (
    _activePageCache &&
    _activePageCache.site === site &&
    _activePageCache.activePageId === activePageId
  ) {
    return _activePageCache.page
  }
  const page = site.pages.find((p) => p.id === activePageId) ?? null
  _activePageCache = { site, activePageId, page }
  return page
}

/** Select whether the docked right sidebar is currently taking layout space. */
export const selectRightSidebarExpanded = (s: EditorStore) =>
  s.propertiesPanelMode === 'docked' &&
  !s.propertiesPanel.collapsed &&
  Boolean(
    s.selectedNodeId ||
      s.selectedSelectorClassId ||
      s.selectedSelectorClassIds.length > 0,
  )

// ---------------------------------------------------------------------------
// selectActiveCanvasPage — VC-aware canvas page selector (Task #438)
//
// When activeDocument is a VC, builds a virtual Page from the VC's rootNode
// tree so NodeRenderer + BreakpointFrame work unchanged.
//
// Memoised via WeakMap keyed on vc (the whole VC object) — Immer gives a new
// ref on ANY field change (name, params, rootNode…), so the WeakMap
// misses precisely when the VC changes and we rebuild.  Same-reference vc → cache hit.
// ---------------------------------------------------------------------------

/** @internal — module-level WeakMap for stable virtual-page references */
const _vcVirtualPageCache = new WeakMap<object, Page>()

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
    const vc = s.site?.visualComponents?.find(
      (v) => v.id === activeDocument.vcId,
    ) ?? null
    if (!vc) return null

    // WeakMap key: vc object — Immer gives a new ref on ANY field change (name,
    // params, tree…). Keying on vc.tree would miss renames because Immer reuses
    // the tree object when only top-level VC fields change (O-2 / CR #666 finding).
    const cached = _vcVirtualPageCache.get(vc as object)
    if (cached) return cached

    const virtualPage = flattenVCToVirtualPage(vc)
    _vcVirtualPageCache.set(vc as object, virtualPage)
    return virtualPage
  }

  return null
}

/**
 * Select the currently selected PageNode.
 *
 * Uses selectActiveCanvasPage so this works in BOTH page mode and VC canvas mode.
 * Without this, PropertiesPanel returns null when a node is
 * selected inside a VC tree (O-1 / CR #666 finding — promoted to MUST-FIX).
 */
export const selectSelectedNode = (s: EditorStore) => {
  if (!s.selectedNodeId) return null
  return selectActiveCanvasPage(s)?.nodes[s.selectedNodeId] ?? null
}

// ---------------------------------------------------------------------------
// Undo / Redo hooks — subscribe only to the flags, not the full site,
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
