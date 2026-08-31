import { DockSolidIcon } from 'pixel-art-icons/icons/dock-solid'
import { OpenSolidIcon } from 'pixel-art-icons/icons/open-solid'
import { Button } from '@ui/components/Button'
import type { PanelMode } from '@admin/state/workspaceLayoutStorage'

interface PanelModeButtonProps {
  mode: PanelMode
  panelLabel: string
  dockLocation: string
  onToggle: () => void
}

/** Shared icon action for moving a panel between its sidebar and the canvas. */
export function PanelModeButton({
  mode,
  panelLabel,
  dockLocation,
  onToggle,
}: PanelModeButtonProps) {
  const floating = mode === 'floating'
  const actionLabel = floating ? `Dock ${panelLabel} panel` : `Unpin ${panelLabel} panel`
  const tooltip = floating ? `Dock in ${dockLocation}` : 'Unpin to floating panel'

  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      onClick={onToggle}
      aria-label={actionLabel}
      tooltip={tooltip}
    >
      {floating ? (
        <DockSolidIcon size={12} aria-hidden="true" />
      ) : (
        <OpenSolidIcon size={12} aria-hidden="true" />
      )}
    </Button>
  )
}
