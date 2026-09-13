import { lazy, Suspense, useRef, type CSSProperties, type ReactNode } from 'react'
import { useEditorStore } from '@site/store/store'
import type { LeftSidebarPanelId, PanelMode } from '@site/store/slices/uiSlice'
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
import { PanelResizeHandle, useDraggablePanel, useResizablePanel } from '@admin/shared/FloatingWindow'
import type { DockablePanelProps } from '@admin/shared/Panel'
import type { FloatingPanelId } from '@admin/state/workspaceLayoutStorage'
import { cn } from '@ui/cn'
import styles from './LeftSidebar.module.css'

const AgentPanel = lazy(() =>
  import('@site/panels/AgentPanel').then((module) => ({ default: module.AgentPanel })),
)

const READ_ONLY_RAIL_IDS: ReadonlySet<LeftSidebarPanelId> = new Set(['explorer'])
const PANEL_LABELS: Record<LeftSidebarPanelId, string> = {
  explorer: 'Explorer',
  selectors: 'Selectors',
  framework: 'Framework',
  dependencies: 'Dependencies',
  agent: 'AI Assistant',
}

interface LeftSidebarProps {
  workspace?: 'site' | 'content' | 'media'
  railOnly?: boolean
  editable?: boolean
  canUseAiChat?: boolean
}

function selectActiveDockedPanel(
  state: ReturnType<typeof useEditorStore.getState>,
): LeftSidebarPanelId | null {
  const candidates: Array<[LeftSidebarPanelId, boolean]> = [
    ['explorer', state.explorerPanelOpen],
    ['selectors', state.selectorsPanelOpen],
    ['framework', state.frameworkPanelOpen],
    ['dependencies', state.dependenciesPanelOpen],
    ['agent', state.isAgentOpen],
  ]
  return candidates.find(([panel, open]) => open && state.leftPanelModes[panel] === 'docked')?.[0]
    ?? null
}

export function LeftSidebar({
  workspace = 'site',
  railOnly = false,
  editable = true,
  canUseAiChat = true,
}: LeftSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const activeDockedPanel = useEditorStore(selectActiveDockedPanel)
  const activePluginPanelId = useEditorStore((s) => s.activePluginPanelId)
  const pluginPanelMode = useEditorStore((s) => s.pluginPanelMode)
  const leftSidebarWidth = useEditorStore((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useEditorStore((s) => s.setLeftSidebarWidth)
  const setPluginPanelMode = useEditorStore((s) => s.setPluginPanelMode)
  const explorerOpen = useEditorStore((s) => s.explorerPanelOpen)
  const selectorsOpen = useEditorStore((s) => s.selectorsPanelOpen)
  const frameworkOpen = useEditorStore((s) => s.frameworkPanelOpen)
  const dependenciesOpen = useEditorStore((s) => s.dependenciesPanelOpen)
  const agentOpen = useEditorStore((s) => s.isAgentOpen)

  const effectiveActivePanel = activeDockedPanel === null
    ? null
    : canShowBuiltInPanel(activeDockedPanel, editable, canUseAiChat)
      ? activeDockedPanel
      : editable
        ? null
        : 'explorer'
  const dockedPluginPanelId = editable && pluginPanelMode === 'docked'
    ? activePluginPanelId
    : null
  const panelExpanded = !railOnly
    && (effectiveActivePanel !== null || dockedPluginPanelId !== null)
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
      data-active-panel={dockedPluginPanelId !== null
        ? `plugin:${dockedPluginPanelId}`
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
        <BuiltInPanelHost panel="explorer" open={explorerOpen} activeDockedPanel={effectiveActivePanel}>
          {(props) => <ExplorerPanel editable={editable} {...props} />}
        </BuiltInPanelHost>

        {editable && (
          <>
            <BuiltInPanelHost panel="selectors" open={selectorsOpen} activeDockedPanel={effectiveActivePanel}>
              {(props) => <SelectorsPanel {...props} />}
            </BuiltInPanelHost>
            <BuiltInPanelHost panel="framework" open={frameworkOpen} activeDockedPanel={effectiveActivePanel}>
              {(props) => <FrameworkPanel {...props} />}
            </BuiltInPanelHost>
            <BuiltInPanelHost panel="dependencies" open={dependenciesOpen} activeDockedPanel={effectiveActivePanel}>
              {(props) => <DependenciesPanel {...props} />}
            </BuiltInPanelHost>
            {activePluginPanelId !== null && (
              <FloatingPanelHost
                panelId="plugin"
                label="Plugin"
                mode={pluginPanelMode}
                open
                activeDocked={dockedPluginPanelId !== null}
                onToggleMode={() => setPluginPanelMode(
                  pluginPanelMode === 'docked' ? 'floating' : 'docked',
                )}
              >
                {(props) => <PluginEditorPanel panelId={activePluginPanelId} {...props} />}
              </FloatingPanelHost>
            )}
          </>
        )}

        {canUseAiChat && (
          <BuiltInPanelHost panel="agent" open={agentOpen} activeDockedPanel={effectiveActivePanel}>
            {(props) => (
              <AgentStoreProvider store={useEditorStore}>
                <Suspense fallback={null}>
                  <AgentPanel variant="docked" {...props} />
                </Suspense>
              </AgentStoreProvider>
            )}
          </BuiltInPanelHost>
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

function BuiltInPanelHost({
  panel,
  open,
  activeDockedPanel,
  children,
}: {
  panel: LeftSidebarPanelId
  open: boolean
  activeDockedPanel: LeftSidebarPanelId | null
  children: (props: DockablePanelProps) => ReactNode
}) {
  const mode = useEditorStore((s) => s.leftPanelModes[panel])
  const setMode = useEditorStore((s) => s.setLeftSidebarPanelMode)
  return (
    <FloatingPanelHost
      panelId={panel}
      label={PANEL_LABELS[panel]}
      mode={mode}
      open={open}
      activeDocked={activeDockedPanel === panel}
      onToggleMode={() => setMode(panel, mode === 'docked' ? 'floating' : 'docked')}
    >
      {children}
    </FloatingPanelHost>
  )
}

function FloatingPanelHost({
  panelId,
  label,
  mode,
  open,
  activeDocked,
  onToggleMode,
  children,
}: {
  panelId: FloatingPanelId
  label: string
  mode: PanelMode
  open: boolean
  activeDocked: boolean
  onToggleMode: () => void
  children: (props: DockablePanelProps) => ReactNode
}) {
  const floating = mode === 'floating'
  const visible = floating ? open : activeDocked
  const leftSidebarWidth = useEditorStore((s) => s.leftSidebarWidth)
  const { panelRef, setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    panelId,
    () => ({ x: 58, y: 64 }),
  )
  const { panelSizeStyle, resizeHandleProps } = useResizablePanel(
    panelId,
    panelRef,
    () => ({ width: leftSidebarWidth, height: 520 }),
  )

  return (
    <div
      ref={floating ? setPanelRef : undefined}
      className={cn(styles.panelSlot, floating && styles.panelSlotFloating)}
      data-testid={`left-panel-${panelId}-host`}
      data-mode={mode}
      hidden={!visible}
      inert={visible ? undefined : true}
      style={floating ? { ...panelPositionStyle, ...panelSizeStyle } : undefined}
    >
      <div className={styles.panelMount}>
        {children({
          mode,
          dragHandleProps: floating ? headerDragProps : undefined,
          onToggleMode,
        })}
      </div>
      {floating && visible && (
        <PanelResizeHandle panelLabel={label} resizeHandleProps={resizeHandleProps} />
      )}
    </div>
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
