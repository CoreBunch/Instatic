/**
 * editorTourSteps — the Site editor's first-run guided tour.
 *
 * Seven `TourStepDef`s driven by the generic `tourStore` / `TourOverlay`
 * (`@admin/shared/tour`). Each step's `prepare()` puts the editor into the
 * state its anchor needs (open the right left-sidebar panel, dock the
 * Properties panel, etc.) before `TourOverlay` waits for the anchor to
 * appear — see `useEditorTour.ts` for when the tour starts.
 *
 * `properties` is the one step whose anchor needs more than a panel-mode
 * flip: `[data-testid="properties-panel"]` only renders when the panel is
 * docked, NOT collapsed, AND something is selected (node, selector class,
 * or a selector multi-select — see `selectRightSidebarExpanded` in
 * `@site/store/store` and the early-return in `PropertiesPanel.tsx`). A
 * fresh site editor session usually has nothing selected, so this step
 * also selects the active page's root node when the selection is empty —
 * selecting a node clears `propertiesPanel.collapsed` for free (see
 * `applySelection` in `selectionSlice.ts`).
 */
import type { TourStepDef } from '@admin/shared/tour'
import { selectActivePage, useEditorStore } from '@site/store/store'

function openExplorerSiteTab() {
  const store = useEditorStore.getState()
  store.setLeftSidebarPanel('explorer')
  store.setExplorerPanelTab('site')
}

function dockPropertiesPanelWithSelection() {
  const store = useEditorStore.getState()
  if (store.propertiesPanelMode !== 'docked') store.setPropertiesPanelMode('docked')

  const hasSelection =
    store.selectedNodeId !== null ||
    store.selectedSelectorClassId !== null ||
    store.selectedSelectorClassIds.length > 0
  if (hasSelection) return

  // Nothing selected yet — select the active page's root node so the
  // docked panel actually renders (see module doc comment above).
  const activePage = selectActivePage(store)
  if (activePage) store.selectNode(activePage.rootNodeId)
}

function openFrameworkPanel() {
  useEditorStore.getState().setLeftSidebarPanel('framework')
}

export const editorTourSteps: TourStepDef[] = [
  {
    id: 'welcome',
    anchor: null,
    title: 'Welcome to the site editor',
    body: 'This is where you build your site. This one-minute tour shows you where everything lives — replay it anytime from the command palette (Cmd-K).',
  },
  {
    id: 'explorer',
    anchor: 'site-explorer-panel',
    title: 'Pages, templates and components',
    body: 'The Explorer’s Site tab lists every page in your site. Your site starts with a Home page — open any page to edit it on the canvas.',
    side: 'right',
    prepare: openExplorerSiteTab,
  },
  {
    id: 'new-page',
    anchor: 'site-explorer-new-page',
    title: 'Create a new page',
    body: 'New pages start here — blank, from a starter layout, or imported from HTML.',
    side: 'right',
    prepare: openExplorerSiteTab,
  },
  {
    id: 'modules',
    anchor: 'canvas-notch',
    title: 'Add content with modules',
    body: 'The + button inserts modules — text, images, buttons, containers and more. Undo and redo live here too.',
    side: 'bottom',
  },
  {
    id: 'properties',
    anchor: 'properties-panel',
    title: 'Style the selected element',
    body: 'Everything about the selected element — layout, spacing, typography, attributes — is edited in the Properties panel.',
    side: 'left',
    prepare: dockPropertiesPanelWithSelection,
  },
  {
    id: 'framework',
    anchor: 'panel-rail-framework',
    title: 'Your design variables',
    body: 'Click this purple Framework icon in the left rail to open your design variables — site-wide Colors, Type and Space tokens. Change them once, they update everywhere.',
    side: 'right',
    prepare: openFrameworkPanel,
  },
  {
    id: 'publish',
    anchor: 'toolbar-publish-btn',
    title: 'Publish when ready',
    body: 'Your edits stay drafts until you publish. That’s the tour — replay it anytime with Cmd-K → “Take the editor tour”.',
    side: 'bottom',
  },
]
