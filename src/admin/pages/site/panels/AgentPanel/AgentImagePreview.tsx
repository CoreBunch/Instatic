import { useEffect, useEffectEvent, useRef, type MouseEvent } from 'react'
import { FloatingWindow } from '@admin/shared/FloatingWindow'
import {
  isContextMenuKey,
  keyboardImageMenuPosition,
  type AgentPreviewImage,
  type OpenAgentImageMenu,
} from './agentImageTypes'
import styles from './AgentImagePreview.module.css'

interface AgentImagePreviewProps {
  image: AgentPreviewImage | null
  imageMenuOpen: boolean
  onOpenImageMenu: OpenAgentImageMenu
  onClose(): void
}

export function AgentImagePreview({
  image,
  imageMenuOpen,
  onOpenImageMenu,
  onClose,
}: AgentImagePreviewProps) {
  const windowRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const closeFromKeyboard = useEffectEvent(onClose)
  const openMenuFromKeyboard = useEffectEvent(onOpenImageMenu)

  useEffect(() => {
    if (!image) return
    const currentImage = image
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        // A portalled image menu owns the first Escape. Let its item-level
        // handler close the menu while this preview stays mounted.
        if (event.target instanceof Element && event.target.closest('[role="menu"]')) return
        event.preventDefault()
        // The AgentPanel also owns an Escape shortcut. Capture and stop this
        // event so one keypress closes the preview without closing the panel.
        event.stopImmediatePropagation()
        closeFromKeyboard()
        return
      }
      if (
        !isContextMenuKey(event)
        || imageMenuOpen
        || !windowRef.current?.contains(document.activeElement)
        || !imageRef.current
      ) return
      event.preventDefault()
      event.stopImmediatePropagation()
      openMenuFromKeyboard({
        image: currentImage,
        ...keyboardImageMenuPosition(imageRef.current),
        returnFocus: windowRef.current,
      })
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [image, imageMenuOpen])

  useEffect(() => {
    if (!image) return
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = requestAnimationFrame(() => windowRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [image])

  function openPointerMenu(event: MouseEvent<HTMLImageElement>): void {
    if (!image) return
    event.preventDefault()
    event.stopPropagation()
    onOpenImageMenu({
      image,
      x: event.clientX,
      y: event.clientY,
      returnFocus: windowRef.current,
    })
  }

  return (
    <FloatingWindow
      ref={windowRef}
      panelId="agentImagePreview"
      open={image !== null}
      title={image?.title ?? 'Image preview'}
      ariaLabel={image?.title ?? 'Image preview'}
      testId="agent-image-preview"
      defaultPosition={{
        x: Math.max(16, (window.innerWidth - 820) / 2),
        y: Math.max(16, (window.innerHeight - 640) / 2),
      }}
      width="min(820px, calc(100vw - var(--space-2xl)))"
      height="min(640px, calc(100vh - var(--space-2xl)))"
      maxHeight="calc(100vh - var(--space-2xl))"
      bodyClassName={styles.surface}
      onClose={onClose}
    >
      {image && (
        <img
          ref={imageRef}
          src={image.src}
          alt={image.alt}
          draggable={false}
          className={styles.image}
          onContextMenu={openPointerMenu}
        />
      )}
    </FloatingWindow>
  )
}
