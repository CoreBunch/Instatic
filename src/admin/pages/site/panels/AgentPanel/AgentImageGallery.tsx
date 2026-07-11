import type { KeyboardEvent, MouseEvent } from 'react'
import { Button } from '@ui/components/Button'
import {
  isContextMenuKey,
  keyboardImageMenuPosition,
  type AgentPreviewImage,
  type OpenAgentImageMenu,
} from './agentImageTypes'
import styles from './AgentImageGallery.module.css'

interface AgentImageGalleryProps {
  images: AgentPreviewImage[]
  label: string
  onOpenImage(image: AgentPreviewImage): void
  onOpenImageMenu: OpenAgentImageMenu
}

/** Compact, shared gallery for user, assistant, and browser-tool images. */
export function AgentImageGallery({
  images,
  label,
  onOpenImage,
  onOpenImageMenu,
}: AgentImageGalleryProps) {
  if (images.length === 0) return null

  function openPointerMenu(image: AgentPreviewImage, event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault()
    event.stopPropagation()
    onOpenImageMenu({
      image,
      x: event.clientX,
      y: event.clientY,
      returnFocus: event.currentTarget,
    })
  }

  function openKeyboardMenu(image: AgentPreviewImage, event: KeyboardEvent<HTMLButtonElement>): void {
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
      className={styles.gallery}
      data-count={Math.min(images.length, 3)}
      role="group"
      aria-label={label}
    >
      {images.map((image) => (
        <Button
          key={image.id}
          type="button"
          variant="ghost"
          size="sm"
          shape="flush"
          aria-label={`Open image preview: ${image.alt}`}
          aria-haspopup="dialog"
          className={styles.thumbnailButton}
          onClick={() => onOpenImage(image)}
          onContextMenu={(event) => openPointerMenu(image, event)}
          onKeyDown={(event) => openKeyboardMenu(image, event)}
        >
          <img
            src={image.src}
            alt={image.alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            className={styles.thumbnail}
          />
        </Button>
      ))}
    </div>
  )
}
