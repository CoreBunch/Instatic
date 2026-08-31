/**
 * MediaSidebar — left rail + panel slot for the Media workspace.
 *
 * Mirrors the structure of `ContentSidebar`: a panel rail with one toggle
 * for the Folders panel and a panel slot that mounts the panel body.
 *
 * The Folders panel itself owns the entire folder navigation: the regular
 * folder tree, the built-in smart folders (Recent uploads, Missing alt
 * text), and the Trash sentinel — all as rows in one tree. There are no
 * separate Smart / Trash panels.
 *
 * Reuses the editor's PanelRail / LeftSidebar CSS so the visual language is
 * identical across Site / Content / Media.
 */
import { useRef, type CSSProperties } from 'react'
import { Button } from '@ui/components/Button'
import { assignRailAccents, railTintVar } from '@ui/railAccent'
import { CloudUploadSolidIcon } from 'pixel-art-icons/icons/cloud-upload-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import type { IconComponent } from 'pixel-art-icons/types'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { hasCapability } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { SidebarResizeHandle } from '@admin/shared/SidebarResizeHandle'
import { Panel } from '@admin/shared/Panel'
import leftSidebarStyles from '@site/sidebars/LeftSidebar/LeftSidebar.module.css'
import panelRailStyles from '@site/sidebars/PanelRail/PanelRail.module.css'
import { MediaFolderPanel } from '../MediaFolderPanel/MediaFolderPanel'
import { MediaStoragePanel } from '../MediaStoragePanel/MediaStoragePanel'
import type { UseMediaWorkspaceResult } from '../../hooks/useMediaWorkspace'

export type MediaSidebarPanelId = 'folders' | 'storage'

interface MediaSidebarProps {
  workspace: UseMediaWorkspaceResult
  activePanel: MediaSidebarPanelId | null
  onActivePanelChange: (panel: MediaSidebarPanelId | null) => void
}

interface RailItem {
  id: MediaSidebarPanelId
  label: string
  icon: IconComponent
  iconName: string
}

/**
 * Every available rail item. The actual rendered set is filtered by
 * `useRailItems` below so panels gated on a capability (e.g. storage =
 * `storage.elect`) are hidden for users who can't use them anyway —
 * rather than showing a button that produces a 403 on first click.
 */
const ALL_RAIL_ITEMS: RailItem[] = [
  { id: 'folders', label: 'Folders', icon: FolderGlyphIcon, iconName: 'folder' },
  { id: 'storage', label: 'Storage', icon: CloudUploadSolidIcon, iconName: 'cloud-upload' },
]

export function MediaSidebar({ workspace, activePanel, onActivePanelChange }: MediaSidebarProps) {
  const sidebarRef = useRef<HTMLElement | null>(null)
  const leftSidebarWidth = useWorkspaceLayout((s) => s.leftSidebarWidth)
  const setLeftSidebarWidth = useWorkspaceLayout((s) => s.setLeftSidebarWidth)
  const currentUser = useCurrentAdminUser()
  const panelWidth = activePanel ? leftSidebarWidth : 0
  const style = {
    '--left-sidebar-panel-width': `${panelWidth}px`,
    '--left-sidebar-panel-layout-width': `${leftSidebarWidth}px`,
  } as CSSProperties

  // Storage election changes which adapter handles each asset role.
  // Gated by `storage.elect` (split from the old `runtime.manage`). Hide
  // the rail button entirely for users who can't use it; the API
  // endpoints also enforce this gate server-side as defense-in-depth.
  const railItems: RailItem[] = ALL_RAIL_ITEMS.filter((item) => {
    if (item.id === 'storage') return hasCapability(currentUser, 'storage.elect')
    return true
  })
  const panelTitle = railItems.find((item) => item.id === activePanel)?.label ?? ''
  const railAccents = assignRailAccents(
    railItems,
    (item) => `media:${item.id}:${item.label}`,
  )

  // Defensive: if the user previously had the storage panel open and then
  // had their capability revoked, collapse it on the next render so they
  // don't end up looking at a stale 403-shaped error.
  if (activePanel === 'storage' && !railItems.some((item) => item.id === 'storage')) {
    onActivePanelChange(null)
  }

  function handleRailToggle(panelId: MediaSidebarPanelId) {
    const next = activePanel === panelId ? null : panelId
    onActivePanelChange(next)
  }

  return (
    <aside
      ref={sidebarRef}
      className={leftSidebarStyles.sidebar}
      data-testid="media-left-sidebar"
      data-expanded={activePanel ? 'true' : 'false'}
      data-active-panel={activePanel ?? 'none'}
      style={style}
    >
      <nav
        aria-label="Media panel dock"
        className={panelRailStyles.rail}
        data-testid="media-panel-rail"
      >
        <div className={panelRailStyles.itemGroup}>
          {railItems.map((item, index) => {
            const Icon = item.icon
            const active = activePanel === item.id
            const actionLabel = active ? `Close ${item.label} panel` : `Open ${item.label} panel`
            const accent = railAccents[index] ?? 'mint'
            const buttonStyle = {
              '--rail-icon-tint': railTintVar(accent),
            } as CSSProperties
            return (
              <Button
                key={item.id}
                variant="ghost"
                size="md"
                iconOnly
                pressed={active}
                aria-label={actionLabel}
                tooltip={`${item.label} panel`}
                data-testid={`media-panel-rail-${item.id}`}
                data-icon={item.iconName}
                data-accent={accent}
                style={buttonStyle}
                onClick={() => handleRailToggle(item.id)}
                className={panelRailStyles.railButton}
              >
                <span className={panelRailStyles.activeIndicator} aria-hidden="true" />
                <Icon size={16} className={panelRailStyles.railIcon} />
              </Button>
            )
          })}
        </div>
      </nav>

      <div
        className={leftSidebarStyles.panelSlot}
        data-testid="media-left-sidebar-panel-slot"
        inert={activePanel ? undefined : true}
      >
        <div className={leftSidebarStyles.panelMount}>
          {activePanel && (
            <Panel
              panelId={`media-${activePanel}`}
              title={panelTitle}
              ariaLabel={`${panelTitle} panel`}
              testId={`media-${activePanel}-panel`}
              onClose={() => onActivePanelChange(null)}
              // The folder tree owns its own scroll container (`body="bare"`),
              // but the storage panel is a stack of small cards that
              // wants the standard 8px-padded scroll surface.
              body={activePanel === 'folders' ? 'bare' : 'padded'}
            >
              {activePanel === 'folders' ? (
                <MediaFolderPanel workspace={workspace} />
              ) : (
                <MediaStoragePanel />
              )}
            </Panel>
          )}
        </div>
      </div>

      {activePanel && (
        <SidebarResizeHandle
          side="left"
          width={leftSidebarWidth}
          targetRef={sidebarRef}
          cssVariable="--left-sidebar-panel-width"
          layoutCssVariable="--left-sidebar-panel-layout-width"
          ariaLabel="Resize media sidebar"
          onResize={setLeftSidebarWidth}
        />
      )}
    </aside>
  )
}
