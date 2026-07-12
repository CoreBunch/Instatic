/**
 * IdeSidebar — the IDE's left sidebar, mirroring the Content workspace's
 * sidebar exactly: the shared left-sidebar chrome (42px icon rail +
 * absolutely-positioned panel slot + resize handle + persisted width), with
 * a Files rail button for the file tree and — when the user holds ai.chat —
 * an AI assistant button in the rail's global group, one panel at a time.
 */
import { useRef, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import type { IconComponent } from 'pixel-art-icons/types'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import { railAccent, railTintVar } from '@ui/railAccent'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import leftSidebarStyles from '@site/sidebars/LeftSidebar/LeftSidebar.module.css'
import panelRailStyles from '@site/sidebars/PanelRail/PanelRail.module.css'

export type IdePanelId = 'files' | 'agent'

interface IdeSidebarProps {
  activePanel: IdePanelId | null
  onActivePanelChange: (panel: IdePanelId | null) => void
  filesPanel: ReactNode
  /** AI assistant panel — same docked variant Content/Site use. */
  agentPanel: ReactNode
  canUseAiChat: boolean
}

export function IdeSidebar({
  activePanel,
  onActivePanelChange,
  filesPanel,
  agentPanel,
  canUseAiChat,
}: IdeSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const leftSidebarWidth = useWorkspaceLayout((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useWorkspaceLayout((s) => s.setLeftSidebarWidth)
  const panelWidth = activePanel ? leftSidebarWidth : 0
  const style = {
    '--left-sidebar-panel-width': `${panelWidth}px`,
    '--left-sidebar-panel-layout-width': `${leftSidebarWidth}px`,
  } as CSSProperties

  return (
    <aside
      ref={sidebarRef}
      className={leftSidebarStyles.sidebar}
      data-testid="ide-left-sidebar"
      data-expanded={activePanel ? 'true' : 'false'}
      data-active-panel={activePanel ?? 'none'}
      style={style}
    >
      <nav
        aria-label="Plugin IDE panel dock"
        className={panelRailStyles.rail}
        data-testid="ide-panel-rail"
      >
        <div className={panelRailStyles.primaryStack}>
          <div className={panelRailStyles.itemGroup}>
            <IdeRailButton
              id="files"
              label="Files"
              icon={FileTextSolidIcon}
              iconName="file-text-solid"
              active={activePanel === 'files'}
              onToggle={() => onActivePanelChange(activePanel === 'files' ? null : 'files')}
            />
          </div>
        </div>
        {canUseAiChat && (
          <div className={panelRailStyles.globalGroup} data-testid="ide-panel-rail-global">
            <IdeRailButton
              id="agent"
              label="AI assistant"
              icon={AiSettingsSolidIcon}
              iconName="ai-settings-solid"
              active={activePanel === 'agent'}
              onToggle={() => onActivePanelChange(activePanel === 'agent' ? null : 'agent')}
            />
          </div>
        )}
      </nav>

      <div
        className={leftSidebarStyles.panelSlot}
        data-testid="ide-left-sidebar-panel-slot"
        inert={activePanel ? undefined : true}
      >
        <div className={leftSidebarStyles.panelMount}>
          {activePanel === 'files'
            ? filesPanel
            : activePanel === 'agent' && canUseAiChat
              ? agentPanel
              : null}
        </div>
      </div>

      {activePanel && (
        <SidebarResizeHandle
          side="left"
          width={leftSidebarWidth}
          targetRef={sidebarRef}
          cssVariable="--left-sidebar-panel-width"
          layoutCssVariable="--left-sidebar-panel-layout-width"
          ariaLabel="Resize IDE sidebar"
          onResize={setLeftSidebarWidth}
        />
      )}
    </aside>
  )
}

interface IdeRailButtonProps {
  id: IdePanelId
  label: string
  icon: IconComponent
  iconName: string
  active: boolean
  onToggle: () => void
}

function IdeRailButton({ id, label, icon, iconName, active, onToggle }: IdeRailButtonProps) {
  const RailIcon = icon
  const action = active ? 'Close' : 'Open'
  const accent = railAccent(`pluginIde:${id}:${label}`)
  const style = {
    '--rail-icon-tint': railTintVar(accent),
  } as CSSProperties

  return (
    <Button
      variant="ghost"
      size="md"
      iconOnly
      pressed={active}
      aria-label={`${action} ${label} panel`}
      tooltip={`${label} panel`}
      data-testid={`ide-rail-${id}`}
      data-icon={iconName}
      data-accent={accent}
      style={style}
      onClick={onToggle}
      className={panelRailStyles.railButton}
    >
      <span className={panelRailStyles.activeIndicator} aria-hidden="true" />
      <RailIcon size={16} className={panelRailStyles.railIcon} />
    </Button>
  )
}
