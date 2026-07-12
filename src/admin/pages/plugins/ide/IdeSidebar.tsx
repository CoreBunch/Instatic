/**
 * IdeSidebar — the IDE's left sidebar shell: the shared left-sidebar chrome
 * (width CSS vars + resize handle + persisted width) without a panel rail —
 * the IDE has exactly one pane (Files), so a rail would be dead chrome.
 */
import { useRef, type CSSProperties, type ReactNode } from 'react'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import leftSidebarStyles from '@site/sidebars/LeftSidebar/LeftSidebar.module.css'

export function IdeSidebar({ children }: { children: ReactNode }) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const leftSidebarWidth = useWorkspaceLayout((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useWorkspaceLayout((s) => s.setLeftSidebarWidth)
  const style = {
    '--left-sidebar-panel-width': `${leftSidebarWidth}px`,
    '--left-sidebar-panel-layout-width': `${leftSidebarWidth}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={leftSidebarStyles.sidebar}
      data-testid="ide-left-sidebar"
      data-expanded="true"
      data-active-panel="files"
      style={style}
    >
      <div className={leftSidebarStyles.panelSlot}>
        <div className={leftSidebarStyles.panelMount}>{children}</div>
      </div>
      <SidebarResizeHandle
        side="left"
        width={leftSidebarWidth}
        targetRef={sidebarRef}
        cssVariable="--left-sidebar-panel-width"
        layoutCssVariable="--left-sidebar-panel-layout-width"
        ariaLabel="Resize file tree"
        onResize={setLeftSidebarWidth}
      />
    </aside>
  )
}
