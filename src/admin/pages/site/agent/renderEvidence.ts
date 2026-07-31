import type {
  AgentLayoutImageContext,
  AgentLayoutNodeContext,
  AgentLayoutRect,
  AgentLayoutReportContext,
  AgentLayoutWarningContext,
  AgentRenderSnapshotPayload,
  AgentScreenshotContext,
} from './types'
import { getErrorMessage } from '@core/utils/errorMessage'

const MAX_TEXT_LENGTH = 300
const MAX_COMPUTED_BACKGROUND_IMAGE_LENGTH = 500
const COMPUTED_STYLE_TRUNCATION_SUFFIX = '...[truncated]'
const OVERFLOW_TOLERANCE_PX = 2
const FRAME_WAIT_TIMEOUT_MS = 5_000
const FRAME_WAIT_POLL_MS = 16

// Anthropic rejects any image dimension > 8000px outright (400), and internally
// downsizes the long edge to ~1568px before the model ever sees it. So we cap
// the long edge of the capture here: a tall landing-page screenshot stays under
// the hard limit AND we never ship more pixels than the model actually uses.
const MAX_IMAGE_EDGE = 1568

interface CaptureRenderSnapshotOptions {
  /** Configured breakpoint id to capture. Defaults to the first canvas frame. */
  breakpointId?: string
  /**
   * Scope the capture to a single node's subtree. When set, the screenshot and
   * layout report cover only that node (coordinates relative to its box).
   * Omit to capture the whole breakpoint frame.
   */
  nodeId?: string
  /** When false, only layout is collected (no html-to-image) — faster. */
  captureScreenshot?: boolean
  /** Exact visible or transient frame selected by the browser executor. */
  frame?: HTMLElement
}

interface CaptureRegion {
  rect: DOMRectReadOnly
  width: number
  height: number
  scrollWidth: number
  scrollHeight: number
}

export interface AgentRenderFrameQuery {
  breakpointId?: string
  source?: 'visible' | 'transient'
  requestId?: string
  requireReady?: boolean
}

/**
 * Thrown when a `nodeId`-scoped capture is requested but the node isn't present
 * in the resolved breakpoint frame. Lets the tool dispatcher return a clear,
 * recoverable `aiToolError` (vs. the "no frame at all" null case).
 */
export class SnapshotNodeNotFoundError extends Error {
  readonly nodeId: string
  readonly breakpointId: string

  constructor(nodeId: string, breakpointId: string) {
    super(`Node ${nodeId} not found in the ${breakpointId || 'active'} breakpoint frame.`)
    this.name = 'SnapshotNodeNotFoundError'
    this.nodeId = nodeId
    this.breakpointId = breakpointId
  }
}

/**
 * Capture the rendered canvas on demand: layout report + optional screenshot.
 *
 * By default captures the whole breakpoint frame. Pass `nodeId` to scope the
 * capture to a single node's subtree — a sharper, cheaper image than a tall
 * full-page screenshot, and a layout report narrowed to that section.
 *
 * Called by the browser-bridge `render_snapshot` tool path when Claude
 * actually asks for visual feedback — never on every prompt build (that's
 * the expensive html-to-image cost we used to pay regardless).
 *
 * Returns null when no matching canvas frame exists in the DOM (e.g. when
 * the editor isn't mounted, or the requested breakpoint isn't on screen).
 * Throws SnapshotNodeNotFoundError when the frame exists but `nodeId` doesn't.
 */
export async function captureAgentRenderSnapshot({
  breakpointId,
  nodeId,
  captureScreenshot = true,
  frame: selectedFrame,
}: CaptureRenderSnapshotOptions = {}): Promise<AgentRenderSnapshotPayload | null> {
  if (typeof document === 'undefined') return null

  const frame = selectedFrame ?? findAgentRenderFrame({ breakpointId })
  if (!frame) return null
  const frameBreakpointId = agentRenderFrameBreakpointId(frame)
  if (breakpointId && frameBreakpointId !== breakpointId) return null

  const resolvedBreakpointId = frameBreakpointId || breakpointId || ''

  // Each breakpoint renders the page inside its own <iframe>; the visible host
  // uses `data-breakpoint-id` and the transient host uses a dedicated agent
  // attribute, but actual nodes (`data-node-id`) always live in the iframe's
  // document. So search + capture against `contentDocument`, NOT the host frame.
  const iframe = frame.querySelector<HTMLIFrameElement>('iframe')
  const doc = iframe?.contentDocument ?? null
  if (!doc?.body) return null // frame collapsed or iframe not mounted yet

  // Full-page evidence is framed by the iframe viewport, not by the authored
  // body box. A body may intentionally be centered, transformed, or capped by
  // max-width; none of those styles change the browser viewport the model is
  // meant to inspect. Rasterising <html> also retains the document-canvas
  // background propagation rules that are lost when the body is cloned alone.
  const documentRegion = measureDocumentRegion(doc)
  let root: HTMLElement = doc.documentElement
  let captureRegion = documentRegion
  if (nodeId) {
    const target = doc.querySelector<HTMLElement>(`[data-node-id="${cssAttrEscape(nodeId)}"]`)
    if (!target) throw new SnapshotNodeNotFoundError(nodeId, resolvedBreakpointId)
    root = target
    captureRegion = measureElementRegion(target)
  }

  const layout = collectLayoutReport(root, captureRegion, resolvedBreakpointId, nodeId)
  const screenshot = captureScreenshot
    ? await captureElementScreenshot(root, captureRegion, documentRegion)
    : unavailableScreenshot('Screenshot capture not requested.')

  return {
    breakpointId: resolvedBreakpointId,
    ...(nodeId ? { nodeId } : {}),
    label: nodeId ? `${resolvedBreakpointId} · ${nodeId}` : resolvedBreakpointId,
    width: Math.round(captureRegion.width),
    capturedAt: Date.now(),
    screenshot,
    layout,
  }
}

/** Find an exact visible canvas frame or one one-shot offscreen capture frame. */
export function findAgentRenderFrame({
  breakpointId,
  source = 'visible',
  requestId,
  requireReady = false,
}: AgentRenderFrameQuery = {}): HTMLElement | null {
  if (typeof document === 'undefined') return null

  const breakpointAttribute = source === 'transient'
    ? 'data-agent-snapshot-breakpoint-id'
    : 'data-breakpoint-id'
  const breakpointSelector = breakpointId
    ? `[${breakpointAttribute}="${cssAttrEscape(breakpointId)}"]`
    : `[${breakpointAttribute}]`
  const sourceSelector = source === 'transient' ? '[data-agent-snapshot-frame]' : ''
  const requestSelector = requestId
    ? `[data-agent-snapshot-request-id="${cssAttrEscape(requestId)}"]`
    : ''
  const candidates = document.querySelectorAll<HTMLElement>(
    `${breakpointSelector}${sourceSelector}${requestSelector}`,
  )

  for (const frame of candidates) {
    if (!requireReady || isAgentRenderFrameReady(frame, requestId)) return frame
  }
  return null
}

/** Wait for React to mount and commit an exact canvas iframe. */
export async function waitForAgentRenderFrame(
  query: AgentRenderFrameQuery,
  timeoutMs: number = FRAME_WAIT_TIMEOUT_MS,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const frame = findAgentRenderFrame({ ...query, requireReady: true })
    if (frame) return frame
    await new Promise<void>((resolve) => setTimeout(resolve, FRAME_WAIT_POLL_MS))
  }
  return null
}

function isAgentRenderFrameReady(frame: HTMLElement, requestId?: string): boolean {
  const breakpointId = agentRenderFrameBreakpointId(frame)
  const iframe = frame.querySelector<HTMLIFrameElement>('iframe')
  // Every IframeFrameSurface first exposes a short-lived about:blank document;
  // the load marker identifies the final srcDoc document for visible and
  // transient frames alike. Without this gate, a snapshot requested while a
  // frame is mounting can capture the detached initial body.
  if (iframe?.dataset.instaticCanvasDocumentLoaded !== 'true') return false
  const body = iframe?.contentDocument?.body
  if (!breakpointId || !body || body.dataset.breakpointId !== breakpointId) return false
  return !requestId || iframe.dataset.agentSnapshotReady === requestId
}

function agentRenderFrameBreakpointId(frame: HTMLElement): string {
  return frame.dataset.breakpointId ?? frame.dataset.agentSnapshotBreakpointId ?? ''
}

function cssAttrEscape(value: string): string {
  // Escape attribute-value double quotes/backslashes so the selector parses.
  return value.replace(/[\\"]/g, '\\$&')
}

function collectLayoutReport(
  root: HTMLElement,
  captureRegion: CaptureRegion,
  breakpointId: string,
  nodeId?: string,
): AgentLayoutReportContext {
  const rootRect = captureRegion.rect
  const viewport = {
    width: Math.round(captureRegion.width),
    height: Math.round(captureRegion.height),
    scrollWidth: captureRegion.scrollWidth,
    scrollHeight: captureRegion.scrollHeight,
  }

  const warnings: AgentLayoutWarningContext[] = []
  if (captureRegion.scrollWidth > captureRegion.width + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'horizontal-overflow',
      severity: 'warning',
      message: 'The captured region has horizontal overflow.',
    })
  }
  if (captureRegion.scrollHeight > captureRegion.height + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'vertical-overflow',
      severity: 'info',
      message: 'The captured region has vertical overflow.',
    })
  }

  // querySelectorAll only returns descendants, so include the root itself when
  // it carries a data-node-id (the node-scoped capture case).
  const nodeEls: HTMLElement[] = []
  if (root.dataset.nodeId) nodeEls.push(root)
  nodeEls.push(...Array.from(root.querySelectorAll<HTMLElement>('[data-node-id]')))
  const nodes = nodeEls.map((nodeEl) => collectNodeLayout(rootRect, viewport, nodeEl, warnings))

  const imgEls: HTMLImageElement[] = []
  if (root.tagName === 'IMG') imgEls.push(root as HTMLImageElement)
  imgEls.push(...Array.from(root.querySelectorAll<HTMLImageElement>('img')))
  const images = imgEls.map((img) => collectImageLayout(rootRect, img, warnings))

  return {
    breakpointId,
    ...(nodeId ? { nodeId } : {}),
    viewport,
    nodes,
    images,
    warnings,
  }
}

function collectNodeLayout(
  frameRect: DOMRect,
  viewport: AgentLayoutReportContext['viewport'],
  nodeEl: HTMLElement,
  warnings: AgentLayoutWarningContext[],
): AgentLayoutNodeContext {
  const rect = relativeRect(frameRect, nodeEl.getBoundingClientRect())
  // `nodeEl` IS the rendered element — `data-node-id` is spread directly onto
  // the module's own root tag, so its computed style and overflow geometry
  // describe what the user sees. (Previous code peeked at `firstElementChild`
  // back when a `<div class="nodeWrapper">` sat between `data-node-id` and
  // the rendered tag; that wrapper is gone.)
  const contentEl = nodeEl
  const computed = getComputedStyle(contentEl)
  const text = trimText(nodeEl.textContent ?? '')
  const visible = rect.width > 0 && rect.height > 0 && computed.display !== 'none' && computed.visibility !== 'hidden'
  const nodeId = nodeEl.dataset.nodeId ?? ''

  if (!visible && text) {
    warnings.push({
      type: 'invisible-node',
      severity: 'warning',
      message: 'Node has text content but no visible layout box.',
      nodeId,
    })
  }

  if (rect.x < -OVERFLOW_TOLERANCE_PX || rect.x + rect.width > viewport.width + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'horizontal-overflow',
      severity: 'warning',
      message: 'Node extends beyond the captured region.',
      nodeId,
    })
  }

  if (
    (computed.overflow === 'hidden' || computed.overflowX === 'hidden' || computed.overflowY === 'hidden') &&
    (contentEl.scrollWidth > contentEl.clientWidth + OVERFLOW_TOLERANCE_PX ||
      contentEl.scrollHeight > contentEl.clientHeight + OVERFLOW_TOLERANCE_PX)
  ) {
    warnings.push({
      type: 'hidden-overflow',
      severity: 'warning',
      message: 'Node content appears clipped by hidden overflow.',
      nodeId,
    })
  }

  return {
    nodeId,
    moduleId: nodeEl.dataset.moduleId,
    label: nodeEl.getAttribute('aria-label') ?? undefined,
    text,
    rect,
    visible,
    computed: {
      display: computed.display,
      position: computed.position,
      overflow: computed.overflow,
      color: computed.color,
      backgroundColor: computed.backgroundColor,
      backgroundImage: boundComputedBackgroundImage(computed.backgroundImage),
      backgroundClip: computed.backgroundClip,
      webkitBackgroundClip: computed.getPropertyValue('-webkit-background-clip'),
      webkitTextFillColor: computed.getPropertyValue('-webkit-text-fill-color'),
      fontSize: computed.fontSize,
      lineHeight: computed.lineHeight,
    },
  }
}

function collectImageLayout(
  frameRect: DOMRect,
  img: HTMLImageElement,
  warnings: AgentLayoutWarningContext[],
): AgentLayoutImageContext {
  const wrapper = img.closest<HTMLElement>('[data-node-id]')
  const nodeId = wrapper?.dataset.nodeId
  const image: AgentLayoutImageContext = {
    nodeId,
    src: img.currentSrc || img.src,
    alt: img.alt || undefined,
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    rect: relativeRect(frameRect, img.getBoundingClientRect()),
  }

  // `loading="lazy"` images in a transient offscreen frame may intentionally
  // be incomplete. html-to-image makes its cloned images eager and embeds them
  // before `toCanvas()` resolves; only a completed zero-dimension image is
  // evidence of a real load failure.
  if (img.complete && (img.naturalWidth === 0 || img.naturalHeight === 0)) {
    warnings.push({
      type: 'broken-image',
      severity: 'warning',
      message: 'Image is not loaded or has no natural dimensions.',
      nodeId,
    })
  }

  return image
}

async function captureElementScreenshot(
  root: HTMLElement,
  captureRegion: CaptureRegion,
  documentRegion: CaptureRegion,
): Promise<AgentScreenshotContext> {
  try {
    const { toCanvas } = await import('html-to-image')
    if (captureRegion.width <= 0 || captureRegion.height <= 0) {
      return unavailableScreenshot('Captured element has no visible size.')
    }

    // Cap BOTH dimensions at MAX_IMAGE_EDGE (never upscale past 1:1). A tall
    // page is constrained by its height; a wide one by its width.
    const pixelRatio = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(1, captureRegion.width),
      MAX_IMAGE_EDGE / Math.max(1, captureRegion.height),
    )

    // Always rasterise the iframe document element. A node on its own has no
    // ancestor painting context, while a cloned body omits the <html>/viewport
    // backdrop (including CSS body-background propagation). For node captures,
    // translate that complete document behind a target-sized canvas instead.
    const documentElement = root.ownerDocument.documentElement
    const options: Parameters<typeof toCanvas>[1] = {
      cacheBust: true,
      pixelRatio,
      imagePlaceholder: '',
      width: captureRegion.width,
      height: captureRegion.height,
      canvasWidth: captureRegion.width,
      canvasHeight: captureRegion.height,
    }
    if (root !== documentElement) {
      options.style = {
        width: `${documentRegion.width}px`,
        height: `${documentRegion.height}px`,
        transform: `translate(${formatPixelOffset(documentRegion.rect.left - captureRegion.rect.left)}, ${formatPixelOffset(documentRegion.rect.top - captureRegion.rect.top)})`,
        transformOrigin: 'top left',
      }
    }

    const canvas = await toCanvas(documentElement, options)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Screenshot canvas does not expose a 2D context.')

    // Composite the fallback AFTER html-to-image has painted the authored page.
    // `backgroundColor` cannot be used here: html-to-image also writes it onto
    // the cloned root, which replaces the body's real background. Destination-
    // over fills only pixels the page intentionally left transparent.
    context.save()
    context.globalCompositeOperation = 'destination-over'
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.restore()

    const dataUrl = canvas.toDataURL('image/png')
    const marker = 'base64,'
    const markerIndex = dataUrl.indexOf(marker)
    return {
      status: 'ok',
      mimeType: 'image/png',
      data: markerIndex >= 0 ? dataUrl.slice(markerIndex + marker.length) : dataUrl,
      // Report the PNG's real integer dimensions. Canvas WebIDL conversion can
      // truncate a fractional scaled edge, so recomputing with Math.round()
      // can disagree with the bytes attached to the tool result.
      width: canvas.width,
      height: canvas.height,
    }
  } catch (err) {
    return {
      status: 'error',
      error: getErrorMessage(err, 'Screenshot capture failed.'),
    }
  }
}

function measureElementRegion(element: HTMLElement): CaptureRegion {
  const rect = element.getBoundingClientRect()
  return {
    rect,
    width: rect.width,
    height: rect.height,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  }
}

function measureDocumentRegion(doc: Document): CaptureRegion {
  const html = doc.documentElement
  const body = doc.body
  const view = doc.defaultView
  const htmlRect = html.getBoundingClientRect()
  const bodyRect = body.getBoundingClientRect()
  const viewportWidth = firstPositiveFinite(
    view?.innerWidth,
    html.clientWidth,
    body.clientWidth,
    htmlRect.width,
    bodyRect.width,
  )
  const viewportHeight = firstPositiveFinite(
    view?.innerHeight,
    html.clientHeight,
    body.clientHeight,
    htmlRect.height,
    bodyRect.height,
  )
  const scrollX = firstFinite(view?.scrollX, view?.pageXOffset, html.scrollLeft, body.scrollLeft)
  const scrollY = firstFinite(view?.scrollY, view?.pageYOffset, html.scrollTop, body.scrollTop)
  const scrollWidth = maxFinite(
    viewportWidth,
    html.scrollWidth,
    body.scrollWidth,
    html.offsetWidth,
    body.offsetWidth,
  )
  const scrollHeight = maxFinite(
    viewportHeight,
    html.scrollHeight,
    body.scrollHeight,
    html.offsetHeight,
    body.offsetHeight,
    htmlRect.bottom + scrollY,
    bodyRect.bottom + scrollY,
  )

  return {
    rect: createRect(-scrollX, -scrollY, viewportWidth, scrollHeight),
    width: viewportWidth,
    height: scrollHeight,
    scrollWidth,
    scrollHeight,
  }
}

function firstPositiveFinite(...values: Array<number | undefined>): number {
  return values.find((value) => value !== undefined && Number.isFinite(value) && value > 0) ?? 0
}

function firstFinite(...values: Array<number | undefined>): number {
  return values.find((value) => value !== undefined && Number.isFinite(value)) ?? 0
}

function maxFinite(...values: Array<number | undefined>): number {
  return Math.max(0, ...values.filter((value): value is number => value !== undefined && Number.isFinite(value)))
}

function createRect(x: number, y: number, width: number, height: number): DOMRectReadOnly {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({ x, y, width, height }),
  }
}

function formatPixelOffset(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : round(value)
  return `${normalized}px`
}

function unavailableScreenshot(error: string): AgentScreenshotContext {
  return {
    status: 'unavailable',
    error,
  }
}

function relativeRect(frameRect: DOMRectReadOnly, rect: DOMRectReadOnly): AgentLayoutRect {
  return {
    x: round(rect.left - frameRect.left),
    y: round(rect.top - frameRect.top),
    width: round(rect.width),
    height: round(rect.height),
  }
}

function trimText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > MAX_TEXT_LENGTH
    ? `${normalized.slice(0, MAX_TEXT_LENGTH - 1)}...`
    : normalized
}

function boundComputedBackgroundImage(value: string): string {
  if (value.length <= MAX_COMPUTED_BACKGROUND_IMAGE_LENGTH) return value
  return `${value.slice(
    0,
    MAX_COMPUTED_BACKGROUND_IMAGE_LENGTH - COMPUTED_STYLE_TRUNCATION_SUFFIX.length,
  )}${COMPUTED_STYLE_TRUNCATION_SUFFIX}`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
