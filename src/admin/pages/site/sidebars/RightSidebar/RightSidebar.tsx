import { useRef, type CSSProperties } from 'react'
import { useEditorStore } from '@site/store/store'
import { PropertiesPanel } from '@site/panels/PropertiesPanel'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import styles from './RightSidebar.module.css'

interface RightSidebarProps {
  docked: boolean
  expanded: boolean
}

export function RightSidebar({ docked, expanded }: RightSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const propertiesPanel = useEditorStore((s) => s.propertiesPanel)
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)
  const panelWidth = expanded ? propertiesPanel.width : 0

  const style = {
    '--right-sidebar-panel-width': `${panelWidth}px`,
    '--right-sidebar-panel-layout-width': `${propertiesPanel.width}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={styles.sidebar}
      data-testid="right-sidebar"
      data-expanded={expanded ? 'true' : 'false'}
      data-mode={docked ? 'docked' : 'floating'}
      style={style}
    >
      {expanded && (
        <SidebarResizeHandle
          side="right"
          width={propertiesPanel.width}
          targetRef={sidebarRef}
          cssVariable="--right-sidebar-panel-width"
          layoutCssVariable="--right-sidebar-panel-layout-width"
          ariaLabel="Resize right sidebar"
          onResize={(width) => setPropertiesPanel({ width })}
        />
      )}

      {docked && (
        <div
          className={styles.panelSlot}
          data-testid="right-sidebar-panel-slot"
          inert={expanded ? undefined : true}
        >
          <PropertiesPanel variant="docked" />
        </div>
      )}
    </aside>
  )
}
