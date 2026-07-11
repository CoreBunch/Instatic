import type { KeyboardEvent, MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import {
  isContextMenuKey,
  keyboardImageMenuPosition,
  type AgentPreviewImage,
  type OpenAgentImageMenu,
} from './agentImageTypes'
import type { PendingImageAttachment } from './usePendingImageAttachments'
import styles from './AgentPanel.module.css'

interface PendingImageAttachmentGridProps {
  entries: PendingImageAttachment[]
  actionsDisabled: boolean
  onRemove(id: string): void
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}

export function PendingImageAttachmentGrid({
  entries,
  actionsDisabled,
  onRemove,
  onOpenImage,
  onOpenImageMenu,
}: PendingImageAttachmentGridProps) {
  function openPointerMenu(
    image: AgentPreviewImage,
    event: MouseEvent<HTMLButtonElement>,
  ): void {
    event.preventDefault()
    event.stopPropagation()
    onOpenImageMenu({
      image,
      x: event.clientX,
      y: event.clientY,
      returnFocus: event.currentTarget,
    })
  }

  function openKeyboardMenu(
    image: AgentPreviewImage,
    event: KeyboardEvent<HTMLButtonElement>,
  ): void {
    if (!isContextMenuKey(event.nativeEvent)) return
    event.preventDefault()
    event.stopPropagation()
    onOpenImageMenu({
      image,
      ...keyboardImageMenuPosition(event.currentTarget),
      returnFocus: event.currentTarget,
    })
  }

  return (
    <div
      className={styles.attachmentGrid}
      data-count={Math.min(entries.length, 3)}
      role="group"
      aria-label="Attached images"
    >
      {entries.map((entry) => {
        const image: AgentPreviewImage | null = entry.previewUrl
          ? {
              id: entry.id,
              src: entry.previewUrl,
              alt: entry.filename,
              title: entry.filename,
              filename: entry.filename,
            }
          : null
        return (
          <div
            key={entry.id}
            className={styles.attachmentCard}
            aria-label={`Attached image: ${entry.filename}`}
            aria-busy={entry.status === 'processing'}
            title={entry.filename}
          >
            {image ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                shape="flush"
                className={styles.attachmentPreviewButton}
                aria-label={`Preview attached image: ${entry.filename}`}
                aria-haspopup="dialog"
                onClick={() => onOpenImage(image)}
                onContextMenu={(event) => openPointerMenu(image, event)}
                onKeyDown={(event) => openKeyboardMenu(image, event)}
              >
                <img src={image.src} alt="" className={styles.attachmentPreview} />
              </Button>
            ) : (
              <div className={styles.attachmentPreviewPlaceholder} aria-hidden="true" />
            )}
            <span className={styles.attachmentStatus} role="status" aria-live="polite">
              {entry.status === 'processing'
                ? 'Preparing…'
                : entry.status === 'error'
                  ? 'Failed'
                  : 'Ready'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="micro"
              iconOnly
              disabled={actionsDisabled}
              onClick={() => onRemove(entry.id)}
              tooltip={`Remove ${entry.filename}`}
              aria-label={`Remove attached image: ${entry.filename}`}
              className={styles.attachmentRemove}
            >
              <CloseIcon size={10} aria-hidden="true" />
            </Button>
          </div>
        )
      })}
    </div>
  )
}
