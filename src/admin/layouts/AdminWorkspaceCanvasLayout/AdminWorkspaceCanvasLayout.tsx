/**
 * AdminWorkspaceCanvasLayout — canvas shell for non-site workspaces.
 *
 * Content, Data, and Media use the same full-height canvas chrome as the Site
 * editor, but they do not need Site-editor-only modules: CanvasRoot,
 * PropertiesPanel, DnD, import wizards, or CodeMirror. Keeping this layout
 * separate lets those workspaces render their own canvas/sidebar content
 * without downloading the instatic graph on first paint.
 */

import { lazy, Suspense, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react'
import { Toolbar } from '@site/toolbar/Toolbar'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import { useEditorAppearancePreferences } from '@site/preferences/editorPreferences'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { useAdminUi } from '@admin/state/adminUi'
import { useSiteSummary } from '@admin/state/useSiteSummary'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { useWorkspaceLayoutPersistence } from '@admin/state/useWorkspaceLayoutPersistence'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { canRunPluginBackgroundWork } from '@admin/access'
import type { AdminWorkspace } from '@admin/workspace'
import styles from '../AdminCanvasLayout/AdminCanvasLayout.module.css'
import workspaceStyles from './AdminWorkspaceCanvasLayout.module.css'
import rightSidebarStyles from '@site/sidebars/RightSidebar/RightSidebar.module.css'

const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

type WorkspaceCanvasSection = Extract<AdminWorkspace, 'content' | 'data' | 'media'>

interface AdminWorkspaceCanvasLayoutProps {
  workspace: WorkspaceCanvasSection
  contentSidebar?: ReactNode
  contentCanvas?: ReactNode
  contentRightPanel?: ReactNode
  toolbarRightSlot?: ReactNode
}

export function AdminWorkspaceCanvasLayout({
  workspace,
  contentSidebar,
  contentCanvas,
  contentRightPanel,
  toolbarRightSlot,
}: AdminWorkspaceCanvasLayoutProps) {
  const currentUser = useCurrentAdminUser()
  const pluginBackgroundWorkEnabled = canRunPluginBackgroundWork(currentUser)

  useSiteSummary()
  useWorkspaceLayoutPersistence(workspace)
  useInstalledEditorPlugins(pluginBackgroundWorkEnabled)
  usePluginEventBridge(pluginBackgroundWorkEnabled)

  const appearance = useEditorAppearancePreferences()
  const adminUiSiteName = useAdminUi((s) => s.siteName)
  const adminUiFaviconUrl = useAdminUi((s) => s.siteFaviconUrl)
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
  const rightPanelCollapsed = useWorkspaceLayout((s) => s.rightPanel.collapsed)
  const setRightPanel = useWorkspaceLayout((s) => s.setRightPanel)
  const rightPanelAvailable = workspace !== 'media' && Boolean(contentRightPanel)
  const hasRightSidebar = rightPanelAvailable && !rightPanelCollapsed
  const hasReopenableRightPanel = rightPanelAvailable && !hasRightSidebar

  return (
    <div
      className={styles.shell}
      data-editor-density={appearance.density}
      data-editor-theme={appearance.theme}
      data-editor-text-scale={appearance.textScale}
    >
      <Toolbar
        siteName={adminUiSiteName}
        faviconUrl={adminUiFaviconUrl}
        section={workspace}
        adminNavigationSlot={(
          <AdminSectionNavigation
            section={workspace}
            currentUser={currentUser}
          />
        )}
        rightSlot={toolbarRightSlot}
      />

      <ConfirmDeleteProvider>
        <div className={styles.editorBody}>
          {contentSidebar ?? null}
          <div
            className={cn(styles.canvasStage, hasRightSidebar && styles.canvasStageRightSidebarOpen)}
            data-right-sidebar-expanded={hasRightSidebar ? 'true' : 'false'}
          >
            <div className={styles.canvasContent} key={workspace}>
              {contentCanvas}
            </div>
            {hasReopenableRightPanel && (
              <WorkspaceRightPanelNotch
                workspace={workspace}
                onOpen={() => setRightPanel({ collapsed: false })}
              />
            )}
          </div>
          <WorkspaceRightSidebar
            hidden={!rightPanelAvailable}
            contentPanel={contentRightPanel}
          />
        </div>
      </ConfirmDeleteProvider>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}
    </div>
  )
}

interface WorkspaceRightPanelNotchProps {
  workspace: WorkspaceCanvasSection
  onOpen: () => void
}

function WorkspaceRightPanelNotch({ workspace, onOpen }: WorkspaceRightPanelNotchProps) {
  const label = workspace === 'content' ? 'settings' : 'inspector'
  const testId = workspace === 'content' ? 'content-settings-notch' : `${workspace}-inspector-notch`
  const stopCanvasInteraction = (event: SyntheticEvent) => {
    event.stopPropagation()
  }

  return (
    <div
      className={workspaceStyles.rightPanelNotchShell}
      data-testid={testId}
      onClick={stopCanvasInteraction}
      onMouseDown={stopCanvasInteraction}
      aria-label={`${label} panel`}
    >
      <div className={workspaceStyles.rightPanelNotch}>
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          className={workspaceStyles.rightPanelNotchButton}
          aria-label={`Open ${label} panel`}
          tooltip={`Open ${label} panel`}
          onClick={onOpen}
        >
          <Settings2SolidIcon size={13} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

interface WorkspaceRightSidebarProps {
  hidden: boolean
  contentPanel?: ReactNode
}

function WorkspaceRightSidebar({ hidden, contentPanel }: WorkspaceRightSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const rightPanel = useWorkspaceLayout((s) => s.rightPanel)
  const setRightPanel = useWorkspaceLayout((s) => s.setRightPanel)
  const isExpanded = !hidden && !rightPanel.collapsed
  const panelWidth = isExpanded ? rightPanel.width : 0
  const style = {
    '--right-sidebar-panel-width': `${panelWidth}px`,
    '--right-sidebar-panel-layout-width': `${rightPanel.width}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={rightSidebarStyles.sidebar}
      data-testid="right-sidebar"
      data-expanded={isExpanded ? 'true' : 'false'}
      data-mode="workspace"
      style={style}
    >
      {isExpanded && (
        <SidebarResizeHandle
          side="right"
          width={rightPanel.width}
          targetRef={sidebarRef}
          cssVariable="--right-sidebar-panel-width"
          layoutCssVariable="--right-sidebar-panel-layout-width"
          ariaLabel="Resize right sidebar"
          onResize={(width) => setRightPanel({ width })}
        />
      )}

      {isExpanded && contentPanel && (
        <div
          className={rightSidebarStyles.panelSlot}
          data-testid="right-sidebar-panel-slot"
        >
          {contentPanel}
        </div>
      )}
    </aside>
  )
}
