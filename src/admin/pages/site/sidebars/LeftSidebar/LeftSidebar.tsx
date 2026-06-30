import { useRef, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import type { LeftSidebarPanelId } from '@site/store/slices/uiSlice'
import { AgentPanel } from '@site/panels/AgentPanel'
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
import styles from './LeftSidebar.module.css'

function selectActiveLeftSidebarPanel(state: ReturnType<typeof useEditorStore.getState>): LeftSidebarPanelId | null {
  // A plugin panel takes precedence over the built-in `*PanelOpen` flags;
  // the LeftSidebar reads `activePluginPanelId` separately and shows the
  // plugin mount when set.
  if (state.activePluginPanelId !== null) return null
  if (state.explorerPanelOpen) return 'explorer'
  if (state.selectorsPanelOpen) return 'selectors'
  if (state.frameworkPanelOpen) return 'framework'
  if (state.dependenciesPanelOpen) return 'dependencies'
  if (state.isAgentOpen) return 'agent'
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
  const setLeftSidebarWidth = useEditorStore((s) => s.setLeftSidebarWidth)
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
  const panelExpanded = sidebarOpen && !railOnly
  const panelWidth = panelExpanded ? leftSidebarWidth : 0

  const style = {
    '--left-sidebar-panel-width': `${panelWidth}px`,
    '--left-sidebar-panel-layout-width': `${panelExpanded ? leftSidebarWidth : 0}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={styles.sidebar}
      data-testid="left-sidebar"
      data-expanded={panelExpanded ? 'true' : 'false'}
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
          className={styles.panelSlot}
          data-testid="left-sidebar-panel-slot"
          inert={panelExpanded ? undefined : true}
        >
          {/* Read-only-safe panels — always rendered for any role with
              `site.read`. These are navigation/inspection surfaces, not
              editing tools; each respects its own read-only state internally
              (e.g. TreeNode disables drag + context menu via `editable`). */}
          <div className={styles.panelMount} hidden={effectiveActivePanel !== 'explorer'}>
            <ExplorerPanel editable={editable} />
          </div>
          {/* Editor-only panels — only mounted when the caller can perform
              structural edits. Mounting them for non-editors would expose
              actions (style edits, framework token changes, plugin panels)
              they have no capability to commit. */}
          {editable && (
            <>
              <div className={styles.panelMount} hidden={effectiveActivePanel !== 'selectors'}>
                <SelectorsPanel variant="docked" />
              </div>
              <div className={styles.panelMount} hidden={effectiveActivePanel !== 'framework'}>
                <FrameworkPanel />
              </div>
              <div className={styles.panelMount} hidden={effectiveActivePanel !== 'dependencies'}>
                <DependenciesPanel variant="docked" />
              </div>
              {effectivePluginPanelId !== null && (
                <div
                  className={styles.panelMount}
                  data-testid="left-sidebar-plugin-panel-mount"
                >
                  <PluginEditorPanel panelId={effectivePluginPanelId} />
                </div>
              )}
            </>
          )}
          {canUseAiChat && (
            <div className={styles.panelMount} hidden={effectiveActivePanel !== 'agent'}>
              {/* Inject the site editor's store API so AgentPanel +
                  ModelPicker + ConversationHistory read agent state
                  from useEditorStore. The same components are mounted
                  in ContentPage with a different store.

                  The eslint-disable below covers a known Zustand idiom:
                  `useEditorStore` is the store API AND a hook — we pass
                  the store API here, never call it as a hook in this
                  file. The React-Compiler rule keys on the identifier
                  prefix and can't see through the dual API. */}
              {/* eslint-disable-next-line react-compiler/react-compiler */}
              <AgentStoreProvider store={useEditorStore}>
                <AgentPanel variant="docked" />
              </AgentStoreProvider>
            </div>
          )}
        </div>
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
