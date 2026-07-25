/**
 * PreviewOverlay — full-screen in-browser preview of the current draft page.
 *
 * Builds the active in-memory draft through the authenticated runtime-preview
 * endpoint, then renders the result into a sandboxed <iframe>. The server path
 * owns request-time concerns such as loop and media prefetch, keeping Preview
 * aligned with the public renderer without publishing the draft.
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
import type { Page, SiteDocument } from '@core/page-tree'
import { isAbortError } from '@core/http'
import { buildCmsRuntimePreview } from '@core/persistence'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { useTemplatePreviewContext } from '@site/hooks/useTemplatePreviewContext'
import { EyeSolidIcon } from 'pixel-art-icons/icons/eye-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { pushToast } from '@ui/components/Toast'
import styles from './PreviewOverlay.module.css'

interface PreviewDocumentProps {
  site: SiteDocument
  page: Page
  templatePreviewContext: TemplateRenderDataContext | undefined
}

interface LoadedPreviewDocument {
  site: SiteDocument
  pageId: string
  contextKey: string
  html: string
}

function PreviewDocument({ site, page, templatePreviewContext }: PreviewDocumentProps) {
  const contextKey = JSON.stringify(templatePreviewContext ?? null)
  const reportedErrorRef = useRef<string | null>(null)
  const { data, loading, error, refresh } = useAsyncResource<LoadedPreviewDocument>(
    async (signal) => {
      try {
        const preview = await buildCmsRuntimePreview(
          {
            site,
            pageId: page.id,
            templateContext: templatePreviewContext,
          },
          { signal },
        )
        return {
          site,
          pageId: page.id,
          contextKey,
          html: preview.html,
        }
      } catch (err) {
        if (!signal.aborted && !isAbortError(err)) {
          console.error('[PreviewOverlay] Failed to build preview:', err)
        }
        throw err
      }
    },
    [site, page.id, contextKey],
    { fallbackError: 'Preview build failed' },
  )

  useEffect(() => {
    if (!error) {
      reportedErrorRef.current = null
      return
    }
    if (reportedErrorRef.current === error) return
    reportedErrorRef.current = error
    pushToast({
      kind: 'error',
      title: "Couldn't build preview",
      body: error,
      location: 'preview-overlay',
    })
  }, [error])

  const currentHtml =
    data?.site === site && data.pageId === page.id && data.contextKey === contextKey
      ? data.html
      : null

  if (error) {
    return (
      <EmptyState
        variant="centered"
        title="Preview unavailable"
        description={error}
        action={<Button variant="secondary" onClick={refresh}>Retry preview</Button>}
        role="alert"
        data-testid="preview-error"
      />
    )
  }

  if (loading || !currentHtml) {
    return (
      <EmptyState
        variant="centered"
        title="Building preview…"
        description="Resolving dynamic content and page assets."
        data-testid="preview-loading"
      />
    )
  }

  return (
    <iframe
      srcDoc={currentHtml}
      sandbox=""
      title={`Preview: ${page.title}`}
      data-testid="preview-iframe"
      className={styles.iframe}
    />
  )
}

export function PreviewOverlay() {
  const open = useEditorStore((s) => s.previewOpen)
  const closePreview = useEditorStore((s) => s.closePreview)
  const site = useEditorStore((s) => s.site)
  const activePage = useEditorStore(selectActivePage)
  const { context: templatePreviewContext } = useTemplatePreviewContext(activePage)

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

          {/* ── Sandboxed server-built preview ─────────────────────────── */}
          <div className={styles.previewContent}>
            <PreviewDocument
              site={site}
              page={activePage}
              templatePreviewContext={templatePreviewContext}
            />
          </div>
        </div>
      </div>
    </>
  )
}
