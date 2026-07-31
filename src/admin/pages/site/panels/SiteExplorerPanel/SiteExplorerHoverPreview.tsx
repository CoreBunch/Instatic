import {
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEventHandler,
  type WheelEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { computeFloatingPosition } from '@ui/lib/floatingPosition'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import { useRuntimePreviewDocument } from '@site/preview/useRuntimePreviewDocument'
import { useEditorStore } from '@site/store/store'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { SiteDocument } from '@core/page-tree'
import type { SiteExplorerItemPreview } from './siteExplorerModel'
import styles from './SiteExplorerPanel.module.css'

const DESKTOP_VIEWPORT_WIDTH = 1440
const DESKTOP_VIEWPORT_HEIGHT = 900
const PREVIEW_WIDTH = 320
const PREVIEW_SHELL_PADDING = 4
const PREVIEW_SCALE = PREVIEW_WIDTH / DESKTOP_VIEWPORT_WIDTH
const PREVIEW_HEIGHT = DESKTOP_VIEWPORT_HEIGHT * PREVIEW_SCALE
const PREVIEW_CARD_WIDTH = PREVIEW_WIDTH + PREVIEW_SHELL_PADDING * 2
const PREVIEW_CARD_HEIGHT = PREVIEW_HEIGHT + PREVIEW_SHELL_PADDING * 2

interface SiteExplorerHoverPreviewProps {
  anchor: HTMLElement
  preview: SiteExplorerItemPreview
  onMouseEnter: MouseEventHandler<HTMLElement>
  onMouseLeave: MouseEventHandler<HTMLElement>
  onRequestClose: () => void
}

export function SiteExplorerHoverPreview({
  anchor,
  preview,
  onMouseEnter,
  onMouseLeave,
  onRequestClose,
}: SiteExplorerHoverPreviewProps) {
  const previewRef = useRef<HTMLElement>(null)
  const site = useEditorStore((state) => state.site)
  const { context: templatePreviewContext, loading: templateContextLoading } =
    useTemplatePreviewContext(preview.page)

  useEffect(() => {
    const closeOnScroll = () => {
      // Wheel scrolling inside the scaled iframe is part of the feature. The
      // parent receives that scroll during capture, so keep the card open while
      // the pointer is anywhere over it; scrolling the explorer itself still
      // dismisses the now-stale anchor position.
      if (previewRef.current?.matches(':hover')) return
      onRequestClose()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onRequestClose()
    }

    window.addEventListener('scroll', closeOnScroll, { capture: true, passive: true })
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('scroll', closeOnScroll, { capture: true })
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onRequestClose])

  if (!site) return null

  const position = computeFloatingPosition(anchor.getBoundingClientRect(), {
    floatingWidth: PREVIEW_CARD_WIDTH,
    floatingHeight: PREVIEW_CARD_HEIGHT,
    side: 'right',
    align: 'center',
    offset: 10,
    viewportMargin: 10,
  })
  const previewStyle = {
    '--site-preview-x': `${position.x}px`,
    '--site-preview-y': `${position.y}px`,
    '--site-preview-scale': PREVIEW_SCALE,
  } as CSSProperties

  return createPortal(
    <aside
      ref={previewRef}
      className={styles.hoverPreview}
      style={previewStyle}
      data-side={position.side}
      data-testid="site-explorer-hover-preview"
      aria-label={`${preview.kindLabel} preview: ${preview.page.title}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className={styles.hoverPreviewViewportFrame}>
        {templateContextLoading ? (
          <HoverPreviewStatus label="Resolving preview data…" />
        ) : (
          <HoverPreviewDocument
            site={site}
            preview={preview}
            templatePreviewContext={templatePreviewContext}
          />
        )}
      </div>
    </aside>,
    document.body,
  )
}

interface HoverPreviewDocumentProps {
  site: SiteDocument
  preview: SiteExplorerItemPreview
  templatePreviewContext: TemplateRenderDataContext | undefined
}

function HoverPreviewDocument({
  site,
  preview,
  templatePreviewContext,
}: HoverPreviewDocumentProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { html, loading, error, refresh } = useRuntimePreviewDocument(
    site,
    preview.page,
    templatePreviewContext,
  )

  if (error) {
    return (
      <div className={styles.hoverPreviewStatus} role="alert">
        <span>Preview unavailable</span>
        <Button variant="secondary" size="xs" onClick={refresh}>
          Retry
        </Button>
      </div>
    )
  }

  if (loading || !html) return <HoverPreviewStatus label="Building desktop preview…" />

  function handlePreviewWheel(event: WheelEvent<HTMLDivElement>) {
    const previewWindow = iframeRef.current?.contentWindow
    if (!previewWindow) return
    event.preventDefault()
    previewWindow.scrollBy({
      top: event.deltaY,
      left: event.deltaX,
      behavior: 'auto',
    })
  }

  return (
    <div className={styles.hoverPreviewScrollSurface} onWheel={handlePreviewWheel}>
      <iframe
        ref={iframeRef}
        srcDoc={html}
        sandbox="allow-same-origin"
        tabIndex={-1}
        title={`Desktop preview of ${preview.page.title}`}
        className={styles.hoverPreviewIframe}
        data-testid="site-explorer-hover-preview-iframe"
      />
    </div>
  )
}

function HoverPreviewStatus({ label }: { label: string }) {
  return (
    <div className={styles.hoverPreviewStatus} role="status">
      <span className={styles.hoverPreviewPulse} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}
