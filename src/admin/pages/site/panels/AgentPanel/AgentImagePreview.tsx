import { useEffect, useRef } from 'react'
import { FloatingWindow } from '@admin/shared/FloatingWindow'
import type { AgentPreviewImage } from './AgentImageGallery'
import styles from './AgentImagePreview.module.css'

interface AgentImagePreviewProps {
  image: AgentPreviewImage | null
  onClose(): void
}

export function AgentImagePreview({ image, onClose }: AgentImagePreviewProps) {
  const windowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!image) return
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      // The AgentPanel also owns an Escape shortcut. Capture and stop this
      // event so one keypress closes the preview without closing the panel.
      event.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => document.removeEventListener('keydown', closeOnEscape, true)
  }, [image, onClose])

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
          src={image.src}
          alt={image.alt}
          draggable={false}
          className={styles.image}
        />
      )}
    </FloatingWindow>
  )
}
