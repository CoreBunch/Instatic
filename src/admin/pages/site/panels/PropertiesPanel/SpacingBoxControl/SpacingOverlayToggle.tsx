/**
 * SpacingOverlayToggle — the Spacing section's header action: an eye that
 * pins the canvas "show all spacing" overlay (`spacingOverlayPinned`). The
 * section has no "+" (nothing to add to a box model), so its action slot
 * holds this instead — the same place every other section keeps its one
 * header control.
 */

import { useEditorStore } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'

export function SpacingOverlayToggle() {
  const pinned = useEditorStore((s) => s.spacingOverlayPinned)
  const setPinned = useEditorStore((s) => s.setSpacingOverlayPinned)

  return (
    <Button
      variant="ghost"
      size="xs"
      iconOnly
      aria-pressed={pinned}
      aria-label="Show all spacing on the canvas"
      tooltip={
        pinned
          ? 'Showing every margin and padding on the canvas'
          : 'Show every margin and padding on the canvas'
      }
      onClick={() => setPinned(!pinned)}
    >
      <EyeSolidIcon size={12} aria-hidden="true" />
    </Button>
  )
}
