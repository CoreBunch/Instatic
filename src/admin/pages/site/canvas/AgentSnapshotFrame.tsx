/**
 * One-shot, offscreen canvas frame used by `site_render_snapshot`.
 *
 * The visible editor intentionally omits some viewport iframes: live mode only
 * mounts the active viewport, design frames may be collapsed, and a persisted
 * breakpoint may opt out through `previewFrame:false`. Snapshot capture must
 * not change any of that user-owned UI state, so CanvasRoot mounts this exact-
 * width frame only while the agent is waiting for it.
 *
 * Runtime scripts are deliberately absent. A visual evidence read must not run
 * authored behavior a second time or let an arbitrary script mutate the
 * transient DOM before it is captured.
 */

import { use, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Breakpoint, Page } from '@core/page-tree'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { CanvasComposedTree } from './CanvasComposedTree'
import {
  CanvasBreakpointContext,
  CanvasDocumentContext,
  CanvasFrameElementContext,
  CanvasTemplateContext,
} from './CanvasContexts'
import { IframeFrameSurface } from './IframeFrameSurface'
import {
  CanvasPreviewReadinessContext,
  createCanvasPreviewReadiness,
  type CanvasPreviewReadiness,
} from './CanvasPreviewReadiness'
import styles from './AgentSnapshotFrame.module.css'

const DOM_QUIET_MS = 32

interface AgentSnapshotFrameProps {
  requestId: string
  page: Page
  breakpoint: Breakpoint
  templateContext?: TemplateRenderDataContext
  templateContextLoading: boolean
}

export function AgentSnapshotFrame({
  requestId,
  page,
  breakpoint,
  templateContext,
  templateContextLoading,
}: AgentSnapshotFrameProps) {
  const [previewReadiness] = useState(createCanvasPreviewReadiness)
  if (typeof document === 'undefined') return null

  return createPortal(
    <CanvasPreviewReadinessContext.Provider value={previewReadiness}>
      <div
        className={styles.frame}
        data-agent-snapshot-frame=""
        data-agent-snapshot-request-id={requestId}
        data-agent-snapshot-breakpoint-id={breakpoint.id}
        aria-hidden="true"
        inert
      >
        <IframeFrameSurface
          breakpointId={breakpoint.id}
          width={breakpoint.width}
          dataAttrs={{ 'data-agent-snapshot-iframe': requestId }}
        >
          <CanvasTemplateContext.Provider value={templateContext}>
            <CanvasBreakpointContext.Provider value={breakpoint.id}>
              <CanvasComposedTree page={page} />
              {!templateContextLoading ? (
                <AgentSnapshotReadyMarker
                  requestId={requestId}
                  previewReadiness={previewReadiness}
                />
              ) : null}
            </CanvasBreakpointContext.Provider>
          </CanvasTemplateContext.Provider>
        </IframeFrameSurface>
      </div>
    </CanvasPreviewReadinessContext.Provider>,
    document.body,
  )
}

/** Marks the host iframe after async preview data, fonts, and DOM settle. */
function AgentSnapshotReadyMarker({
  requestId,
  previewReadiness,
}: {
  requestId: string
  previewReadiness: CanvasPreviewReadiness
}) {
  const iframeDocument = use(CanvasDocumentContext)
  const iframe = use(CanvasFrameElementContext)

  useEffect(() => {
    if (!iframeDocument || !iframe) return
    const controller = new AbortController()
    void markAgentSnapshotFrameReady(
      iframe,
      iframeDocument,
      requestId,
      previewReadiness,
      controller.signal,
    )
    return () => {
      cleanupAgentSnapshotFrameReady(iframe, requestId, controller)
    }
  }, [iframe, iframeDocument, previewReadiness, requestId])

  return null
}

// Keep cross-document mutation outside the React component so the compiler can
// treat the context values as read-only React input.
async function markAgentSnapshotFrameReady(
  iframe: HTMLIFrameElement,
  iframeDocument: Document,
  requestId: string,
  previewReadiness: CanvasPreviewReadiness,
  signal: AbortSignal,
): Promise<void> {
  // Let descendant effects register their first data/media requests before an
  // initially-idle tracker can be mistaken for a finished preview.
  if (!await waitForDelay(0, signal)) return

  while (!signal.aborted) {
    if (!await previewReadiness.waitUntilIdle(signal)) return
    const settledRevision = previewReadiness.revision()
    if (!await waitForDocumentQuiet(iframeDocument, signal)) return
    if (
      previewReadiness.pendingCount() !== 0 ||
      previewReadiness.revision() !== settledRevision
    ) continue

    const fonts = iframeDocument.fonts
    if (fonts?.status === 'loading' && !await waitForPromise(fonts.ready, signal)) return
    if (!await waitForDocumentQuiet(iframeDocument, signal)) return
    // A settled data request can add more asynchronous preview work during the
    // resource phase. Restart so the final committed DOM is included as well.
    if (
      previewReadiness.pendingCount() === 0 &&
      previewReadiness.revision() === settledRevision
    ) break
  }

  if (signal.aborted) return
  // Readiness metadata belongs to editor chrome, not authored <html>/<body>.
  // User selectors therefore see exactly the DOM that will publish.
  iframe.dataset.agentSnapshotReady = requestId
}

function cleanupAgentSnapshotFrameReady(
  iframe: HTMLIFrameElement,
  requestId: string,
  controller: AbortController,
): void {
  controller.abort()
  if (iframe.dataset.agentSnapshotReady === requestId) {
    delete iframe.dataset.agentSnapshotReady
  }
}

function waitForDocumentQuiet(
  iframeDocument: Document,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  const MutationObserverCtor = iframeDocument.defaultView?.MutationObserver ?? MutationObserver

  return new Promise<boolean>((resolve) => {
    let finished = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserverCtor(() => scheduleQuietWindow())
    const finish = (settled: boolean) => {
      if (finished) return
      finished = true
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      observer.disconnect()
      signal.removeEventListener('abort', onAbort)
      resolve(settled)
    }
    const onAbort = () => finish(false)
    const scheduleQuietWindow = () => {
      if (finished) return
      if (quietTimer !== undefined) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(true), DOM_QUIET_MS)
    }

    observer.observe(iframeDocument.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    signal.addEventListener('abort', onAbort, { once: true })
    scheduleQuietWindow()
  })
}

function waitForPromise(promise: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let finished = false
    const finish = (settled: boolean) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      resolve(settled)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(() => finish(true), () => finish(true))
  })
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let finished = false
    const timer = setTimeout(() => finish(true), delayMs)
    const finish = (settled: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(settled)
    }
    const onAbort = () => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
