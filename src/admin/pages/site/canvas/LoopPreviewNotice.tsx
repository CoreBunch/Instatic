/**
 * The line a loop shows on the canvas in place of its iterations when it has
 * none and the author needs to know why (see `useLoopPreviewNotice`). Editor
 * chrome only: the published loop renders nothing in the same situation.
 */
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'

export function LoopPreviewNotice({ message }: { message: string }) {
  return (
    <CanvasModulePlaceholder
      variant="inline"
      data-loop-preview-notice=""
      role="status"
      icon={<WarningDiamondSolidIcon size={14} color="currentColor" />}
      label={message}
    />
  )
}
