/**
 * PreviewOverlay — full-screen in-browser preview of the published page.
 *
 * Renders the active page via publishPage() into a sandboxed <iframe> so
 * the user can see exactly what visitors will see before exporting.
 *
 * Accessibility (Guideline #225 / WCAG 2.1 AA):
 * - role="dialog" + aria-modal="true"
 * - Focus trapped: close button receives focus on open, returned on close
 * - Esc closes the overlay
 * - Backdrop click closes the overlay
 *
 * Security:
 * - iframe uses sandbox="" — all sandboxing restrictions applied
 *
 * data-testid="preview-overlay" and data-testid="preview-iframe" for Playwright
 */

import { useEffect, useRef } from 'react'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { publishPage } from '@core/publisher'
import { registry } from '@core/module-engine'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import styles from './PreviewOverlay.module.css'

export function PreviewOverlay() {
  const open = useEditorStore((s) => s.previewOpen)
  const closePreview = useEditorStore((s) => s.closePreview)
  const site = useEditorStore((s) => s.site)
  const activePage = useEditorStore(selectActivePage)
  const templatePreviewContext = useTemplatePreviewContext(activePage)

  const closeBtnRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)

  // Focus management
  useEffect(() => {
    if (open) {
      if (document.activeElement instanceof HTMLElement) {
        triggerRef.current = document.activeElement
      }
      requestAnimationFrame(() => closeBtnRef.current?.focus())
    } else {
      triggerRef.current?.focus()
      triggerRef.current = null
    }
  }, [open])

  // Esc closes the overlay
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePreview()
    }
  }

  if (!open || !site || !activePage) return null

  const { html } = publishPage(activePage, site, registry, {
    templateContext: templatePreviewContext,
  })

  return (
    <>
      {/* Backdrop */}
      <div
        aria-hidden="true"
        onClick={closePreview}
        className={styles.backdrop}
      />

      {/* Dialog wrapper */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Page preview"
        data-testid="preview-overlay"
        onKeyDown={handleKeyDown}
        className={styles.dialogWrapper}
      >
        {/* Inner card */}
        <div className={styles.card}>
          {/* ── Header bar ──────────────────────────────────────────────── */}
          <div className={styles.header}>
            <EyeSolidIcon size={14} color="var(--text-muted)" className={styles.headerIcon} />
            <span className={styles.headerTitle}>
              Preview — {activePage.title}
            </span>

            {/* Close button */}
            <Button
              ref={closeBtnRef}
              variant="ghost"
              size="lg"
              onClick={closePreview}
              aria-label="Close preview"
            >
              <CloseIcon size={12} color="currentColor" aria-hidden="true" />
              Close
            </Button>
          </div>

          {/* ── Sandboxed iframe ───────────────────────────────────────── */}
          <iframe
            srcDoc={html}
            sandbox=""
            title={`Preview: ${activePage.title}`}
            data-testid="preview-iframe"
            className={styles.iframe}
          />
        </div>
      </div>
    </>
  )
}
