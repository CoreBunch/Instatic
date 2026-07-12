/**
 * IdeSidebar — the IDE's left sidebar, mirroring the Content workspace's
 * sidebar exactly: the shared left-sidebar chrome (42px icon rail +
 * absolutely-positioned panel slot + resize handle + persisted width), with
 * a single Files rail button that toggles the file tree panel.
 */
import { useRef, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { railAccent, railTintVar } from '@ui/railAccent'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import leftSidebarStyles from '@site/sidebars/LeftSidebar/LeftSidebar.module.css'
import panelRailStyles from '@site/sidebars/PanelRail/PanelRail.module.css'

interface IdeSidebarProps {
  children: ReactNode
  panelOpen: boolean
  onPanelOpenChange: (open: boolean) => void
}

export function IdeSidebar({ children, panelOpen, onPanelOpenChange }: IdeSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const leftSidebarWidth = useWorkspaceLayout((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useWorkspaceLayout((s) => s.setLeftSidebarWidth)
  const panelWidth = panelOpen ? leftSidebarWidth : 0
  const style = {
    '--left-sidebar-panel-width': `${panelWidth}px`,
    '--left-sidebar-panel-layout-width': `${leftSidebarWidth}px`,
  } as CSSProperties
  const accent = railAccent('pluginIde:files:Files')
  const railButtonStyle = {
    '--rail-icon-tint': railTintVar(accent),
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={leftSidebarStyles.sidebar}
      data-testid="ide-left-sidebar"
      data-expanded={panelOpen ? 'true' : 'false'}
      data-active-panel={panelOpen ? 'files' : 'none'}
      style={style}
    >
      <nav
        aria-label="Plugin IDE panel dock"
        className={panelRailStyles.rail}
        data-testid="ide-panel-rail"
      >
        <div className={panelRailStyles.primaryStack}>
          <div className={panelRailStyles.itemGroup}>
            <Button
              variant="ghost"
              size="md"
              iconOnly
              pressed={panelOpen}
              aria-label={`${panelOpen ? 'Close' : 'Open'} Files panel`}
              tooltip="Files panel"
              data-testid="ide-rail-files"
              data-icon="file-text-solid"
              data-accent={accent}
              style={railButtonStyle}
              onClick={() => onPanelOpenChange(!panelOpen)}
              className={panelRailStyles.railButton}
            >
              <span className={panelRailStyles.activeIndicator} aria-hidden="true" />
              <FileTextSolidIcon size={16} className={panelRailStyles.railIcon} />
            </Button>
          </div>
        </div>
      </nav>

      <div
        className={leftSidebarStyles.panelSlot}
        data-testid="ide-left-sidebar-panel-slot"
        inert={panelOpen ? undefined : true}
      >
        <div className={leftSidebarStyles.panelMount}>{children}</div>
      </div>

      {panelOpen && (
        <SidebarResizeHandle
          side="left"
          width={leftSidebarWidth}
          targetRef={sidebarRef}
          cssVariable="--left-sidebar-panel-width"
          layoutCssVariable="--left-sidebar-panel-layout-width"
          ariaLabel="Resize file tree"
          onResize={setLeftSidebarWidth}
        />
      )}
    </aside>
  )
}
