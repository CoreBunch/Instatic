import { useRef, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { BookOpenSolidIcon } from 'pixel-art-icons/icons/book-open-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { AiSettingsSolidIcon } from 'pixel-art-icons/icons/ai-settings-solid'
import type { IconComponent } from 'pixel-art-icons/types'
import { railAccent, railTintVar } from '@ui/railAccent'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import leftSidebarStyles from '../../../site/sidebars/LeftSidebar/LeftSidebar.module.css'
import panelRailStyles from '../../../site/sidebars/PanelRail/PanelRail.module.css'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'

export type ContentPanelId = 'content' | 'media' | 'agent'

interface ContentSidebarProps {
  activePanel: ContentPanelId | null
  onActivePanelChange: (panel: ContentPanelId | null) => void
  contentPanel: ReactNode
  mediaPanel: ReactNode
  /**
   * AI Assistant panel. Mounted in the same panel slot as content + media
   * (same docked variant the site editor uses), so the chat lives inside
   * the workspace chrome instead of floating over it.
   */
  agentPanel: ReactNode
  canUseAiChat: boolean
}

export function ContentSidebar({
  activePanel,
  onActivePanelChange,
  contentPanel,
  mediaPanel,
  agentPanel,
  canUseAiChat,
}: ContentSidebarProps) {
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
      data-testid="left-sidebar"
      data-expanded={activePanel ? 'true' : 'false'}
      data-active-panel={activePanel ?? 'none'}
      style={style}
    >
      <nav
        aria-label="Content panel dock"
        className={panelRailStyles.rail}
        data-testid="content-panel-rail"
      >
        <div className={panelRailStyles.primaryStack}>
          <div className={panelRailStyles.itemGroup} data-testid="panel-rail-primary">
            <ContentRailButton
              id="content"
              label="Content"
              icon={BookOpenSolidIcon}
              iconName="book-open"
              active={activePanel === 'content'}
              onToggle={() => onActivePanelChange(activePanel === 'content' ? null : 'content')}
            />
            <ContentRailButton
              id="media"
              label="Media"
              icon={ImagesSolidIcon}
              iconName="images"
              active={activePanel === 'media'}
              onToggle={() => onActivePanelChange(activePanel === 'media' ? null : 'media')}
            />
          </div>
        </div>
        {canUseAiChat && (
          <div className={panelRailStyles.globalGroup} data-testid="panel-rail-global">
            <ContentRailButton
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
        data-testid="left-sidebar-panel-slot"
        inert={activePanel ? undefined : true}
      >
        <div className={leftSidebarStyles.panelMount}>
          {activePanel === 'content'
            ? contentPanel
            : activePanel === 'media'
              ? mediaPanel
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
          ariaLabel="Resize content sidebar"
          onResize={setLeftSidebarWidth}
        />
      )}
    </aside>
  )
}

interface ContentRailButtonProps {
  id: ContentPanelId
  label: string
  icon: IconComponent
  iconName: string
  active: boolean
  onToggle: () => void
}

function ContentRailButton({
  id,
  label,
  icon,
  iconName,
  active,
  onToggle,
}: ContentRailButtonProps) {
  const RailIcon = icon
  const actionLabel = active ? `Close ${label} panel` : `Open ${label} panel`
  const accent = railAccent(`content:${id}:${label}`)
  const style = {
    '--rail-icon-tint': railTintVar(accent),
  } as CSSProperties

  return (
    <Button
      variant="ghost"
      size="md"
      iconOnly
      pressed={active}
      aria-label={actionLabel}
      tooltip={`${label} panel`}
      data-testid={`panel-rail-${id}`}
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
