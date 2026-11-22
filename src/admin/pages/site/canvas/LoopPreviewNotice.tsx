/**
 * What a loop shows on the canvas in place of its iterations when it has
 * none and the author needs to know why (see `useLoopPreviewNotice`). Editor
 * chrome only: the published loop renders nothing in the same situation.
 */
import { Button } from '@ui/components/Button'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import type { LoopPreviewNotice as LoopPreviewNoticeInfo } from './useLoopPreviewItems'

/** The "Try again" control of a notice that offers one. */
export function LoopPreviewRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="secondary" size="sm" onClick={onRetry}>
      Try again
    </Button>
  )
}

export function LoopPreviewNotice({ notice }: { notice: LoopPreviewNoticeInfo }) {
  // The inline strip has no room for a control; a notice with one is a block.
  if (notice.onRetry) {
    return (
      <CanvasModulePlaceholder
        data-loop-preview-notice=""
        role="status"
        icon={<WarningDiamondSolidIcon size={16} color="currentColor" />}
        label={notice.message}
        actions={<LoopPreviewRetry onRetry={notice.onRetry} />}
      />
    )
  }
  return (
    <CanvasModulePlaceholder
      variant="inline"
      data-loop-preview-notice=""
      role="status"
      icon={<WarningDiamondSolidIcon size={14} color="currentColor" />}
      label={notice.message}
    />
  )
}
