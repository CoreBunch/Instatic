import { lazy, Suspense, useRef, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import type { LeftSidebarPanelId } from '@site/store/slices/uiSlice'
import { AgentStoreProvider } from '@admin/ai/AgentStoreContext'
import { FrameworkPanel } from '@site/panels/FrameworkPanel'
import { ExplorerPanel } from '@site/panels/ExplorerPanel'
import { DependenciesPanel } from '@site/panels/DependenciesPanel'
import { PanelRail } from '@site/sidebars/PanelRail'
import { PluginEditorPanel } from '@site/panels/PluginEditorPanel'
import { SelectorsPanel } from '@site/panels/SelectorsPanel'
import { FrameworkChangeConfirmProvider } from '@admin/shared/dialogs/FrameworkChangeConfirmDialog'
import { VCDeletionConfirmProvider } from '@admin/shared/dialogs/VCDeletionConfirmDialog'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import {
  PanelResizeHandle,
  useDraggablePanel,
  useResizablePanel,
} from '@admin/shared/FloatingWindow'
import { cn } from '@ui/cn'
import styles from './LeftSidebar.module.css'

// Image preparation and provider catalogue code belong to the AI surface, not
// the editor startup path. A nested boundary lets the sidebar/canvas render as
// soon as their parent chunk is ready, then loads the always-mounted AgentPanel
// independently so its local draft survives panel switches after first load.
const AgentPanel = lazy(() =>
  import('@site/panels/AgentPanel').then((module) => ({ default: module.AgentPanel })),
)

type HostedLeftPanelId = Exclude<LeftSidebarPanelId, 'agent'>

function selectActiveLeftSidebarPanel(
  state: ReturnType<typeof useEditorStore.getState>,
): HostedLeftPanelId | null {
  // A plugin panel takes precedence over the built-in `*PanelOpen` flags;
  // the LeftSidebar reads `activePluginPanelId` separately and shows the
  // plugin mount when set.
  if (state.activePluginPanelId !== null) return null
  if (state.explorerPanelOpen) return 'explorer'
  if (state.selectorsPanelOpen) return 'selectors'
  if (state.frameworkPanelOpen) return 'framework'
  if (state.dependenciesPanelOpen) return 'dependencies'
  return null
}

interface LeftSidebarProps {
  /** Drives the rail-button accent identity hash (`${workspace}:${id}:…`). */
  workspace?: 'site' | 'content' | 'media'
  railOnly?: boolean
  /**
   * Whether the caller can perform structural edits (DnD, add/remove nodes,
   * pages, styles). Controls which side-panels are exposed in the rail.
   *
   * Falsy callers (Viewer / Client) still see the Explorer panel (Layers /
   * Pages / Media navigation surfaces) — they're not editing tools. The
   * structural Selectors / Framework / Dependencies panels stay hidden. The
   * Agent panel is controlled separately by `canUseAiChat`.
   *
   * Each panel is responsible for respecting its own read-only state for
   * the interactions it exposes (TreeNode drag, context menus, etc.).
   */
  editable?: boolean
  canUseAiChat?: boolean
}

/**
 * Set of rail items that remain visible to read-only callers — purely
 * navigational / view surfaces. Anything not in this set is editing-only
 * and is dropped from the rail (and its panel mount) when `editable=false`.
 */
const READ_ONLY_RAIL_IDS: ReadonlySet<LeftSidebarPanelId> = new Set(['explorer'])
const PANEL_RESIZE_LABELS: Record<HostedLeftPanelId, string> = {
  explorer: 'Explorer',
  selectors: 'Selectors',
  framework: 'Framework',
  dependencies: 'Dependencies',
}

export function LeftSidebar({
  workspace = 'site',
  railOnly = false,
  editable = true,
  canUseAiChat = true,
}: LeftSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const activePanel = useEditorStore(selectActiveLeftSidebarPanel)
  const activePluginPanelId = useEditorStore((s) => s.activePluginPanelId)
  const leftSidebarWidth = useEditorStore((s) => s.leftSidebarWidth)
  const leftSidebarMode = useEditorStore((s) => s.leftSidebarMode)
  const setLeftSidebarWidth = useEditorStore((s) => s.setLeftSidebarWidth)
  const setLeftSidebarMode = useEditorStore((s) => s.setLeftSidebarMode)
  // When the user can't edit structure, drop them onto Layers if they had a
  // hidden-for-them panel active (selectors, colors, …). Plugin panels are
  // editing-only by definition.
  const effectiveActivePanel =
    activePanel && canShowBuiltInPanel(activePanel, editable, canUseAiChat)
      ? activePanel
      : editable
        ? null
        : 'explorer'
  const effectivePluginPanelId = editable ? activePluginPanelId : null
  // Sidebar is "expanded" whenever a built-in OR plugin panel is showing.
  const sidebarOpen = Boolean(effectiveActivePanel) || effectivePluginPanelId !== null
  const panelFloating = sidebarOpen && leftSidebarMode === 'floating'
  const panelExpanded = sidebarOpen && leftSidebarMode === 'docked' && !railOnly
  const panelVisible = panelExpanded || panelFloating
  const panelWidth = panelExpanded ? leftSidebarWidth : 0
  const panelResizeLabel = effectivePluginPanelId !== null
    ? 'plugin'
    : effectiveActivePanel
      ? PANEL_RESIZE_LABELS[effectiveActivePanel]
      : 'left sidebar'
  const {
    panelRef,
    setPanelRef,
    headerDragProps,
    panelPositionStyle,
  } = useDraggablePanel('site', () => ({ x: 58, y: 64 }))
  const {
    panelSizeStyle,
    resizeHandleProps,
  } = useResizablePanel(
    'site',
    panelRef,
    () => ({ width: leftSidebarWidth, height: 520 }),
  )

  const togglePanelMode = () => {
    setLeftSidebarMode(leftSidebarMode === 'docked' ? 'floating' : 'docked')
  }
  const dockablePanelProps = {
    mode: leftSidebarMode,
    dragHandleProps: panelFloating ? headerDragProps : undefined,
    onToggleMode: togglePanelMode,
  } as const

  const style = {
    '--left-sidebar-panel-width': `${panelWidth}px`,
    '--left-sidebar-panel-layout-width': `${panelExpanded ? leftSidebarWidth : 0}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={styles.sidebar}
      // Chrome surface: fields here match the inspector's — same ramp.
      data-surface="chrome"
      data-testid="left-sidebar"
      data-expanded={panelExpanded ? 'true' : 'false'}
      // Floating pickers (ColorInput's panel) must not cover the editing
      // chrome — they read this marker and snap back to the canvas.
      data-floating-obstacle=""
      data-rail-only={railOnly ? 'true' : undefined}
      data-active-panel={effectivePluginPanelId !== null
        ? `plugin:${effectivePluginPanelId}`
        : effectiveActivePanel ?? 'none'}
      style={style}
    >
      <PanelRail
        workspace={workspace}
        editable={editable}
        canUseAiChat={canUseAiChat}
        railOnly={railOnly}
      />

      <FrameworkChangeConfirmProvider>
      <VCDeletionConfirmProvider>
        <div
          ref={panelFloating ? setPanelRef : undefined}
          className={cn(styles.panelSlot, panelFloating && styles.panelSlotFloating)}
          data-testid="left-sidebar-panel-slot"
          data-mode={leftSidebarMode}
          inert={panelVisible ? undefined : true}
          style={panelFloating ? { ...panelPositionStyle, ...panelSizeStyle } : undefined}
        >
          {/* Read-only-safe panels — always rendered for any role with
              `site.read`. These are navigation/inspection surfaces, not
              editing tools; each respects its own read-only state internally
              (e.g. TreeNode disables drag + context menu via `editable`). */}
          <div className={styles.panelMount} hidden={effectiveActivePanel !== 'explorer'}>
            <ExplorerPanel editable={editable} {...dockablePanelProps} />
          </div>
          {/* Editor-only panels — only mounted when the caller can perform
              structural edits. Mounting them for non-editors would expose
              actions (style edits, framework token changes, plugin panels)
              they have no capability to commit. */}
          {editable && (
            <>
              <div className={styles.panelMount} hidden={effectiveActivePanel !== 'selectors'}>
                <SelectorsPanel {...dockablePanelProps} />
              </div>
              <div className={styles.panelMount} hidden={effectiveActivePanel !== 'framework'}>
                <FrameworkPanel {...dockablePanelProps} />
              </div>
              <div className={styles.panelMount} hidden={effectiveActivePanel !== 'dependencies'}>
                <DependenciesPanel {...dockablePanelProps} />
              </div>
              {effectivePluginPanelId !== null && (
                <div
                  className={styles.panelMount}
                  data-testid="left-sidebar-plugin-panel-mount"
                >
                  <PluginEditorPanel
                    panelId={effectivePluginPanelId}
                    {...dockablePanelProps}
                  />
                </div>
              )}
            </>
          )}
          {panelFloating && (
            <PanelResizeHandle
              panelLabel={panelResizeLabel}
              resizeHandleProps={resizeHandleProps}
            />
          )}
        </div>
        {canUseAiChat && (
          /* The AI assistant stays independent from the hosted left panel so
             users can keep Layers visible while following a conversation.
             Keeping it mounted also preserves the current draft. */
          // eslint-disable-next-line react-compiler/react-compiler
          <AgentStoreProvider store={useEditorStore}>
            <Suspense fallback={null}>
              <AgentPanel />
            </Suspense>
          </AgentStoreProvider>
        )}
      </VCDeletionConfirmProvider>
      </FrameworkChangeConfirmProvider>

      {panelExpanded && (
        <SidebarResizeHandle
          side="left"
          width={leftSidebarWidth}
          targetRef={sidebarRef}
          cssVariable="--left-sidebar-panel-width"
          layoutCssVariable="--left-sidebar-panel-layout-width"
          ariaLabel="Resize left sidebar"
          onResize={setLeftSidebarWidth}
        />
      )}
    </aside>
  )
}

function canShowBuiltInPanel(
  panel: LeftSidebarPanelId,
  editable: boolean,
  canUseAiChat: boolean,
): boolean {
  if (panel === 'agent') return canUseAiChat
  return editable || READ_ONLY_RAIL_IDS.has(panel)
}
