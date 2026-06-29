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
const OVERFLOW_TOLERANCE_PX = 2

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
}: CaptureRenderSnapshotOptions = {}): Promise<AgentRenderSnapshotPayload | null> {
  if (typeof document === 'undefined') return null

  const frame = findCanvasFrame(breakpointId)
  if (!frame) return null

  const resolvedBreakpointId = frame.dataset.breakpointId ?? breakpointId ?? ''

  // Each breakpoint renders the page inside its own <iframe>; `data-breakpoint-id`
  // is on the host wrapper, but the actual nodes (`data-node-id`) live in the
  // iframe's document. So search + capture against `contentDocument`, NOT the
  // host frame (which is why scoped node lookups previously never matched).
  const iframe = frame.querySelector<HTMLIFrameElement>('iframe')
  const doc = iframe?.contentDocument ?? null
  if (!doc?.body) return null // frame collapsed or iframe not mounted yet

  // The capture root is the iframe body, or — when scoped — the target node.
  let root: HTMLElement = doc.body
  if (nodeId) {
    const target = doc.querySelector<HTMLElement>(`[data-node-id="${cssAttrEscape(nodeId)}"]`)
    if (!target) throw new SnapshotNodeNotFoundError(nodeId, resolvedBreakpointId)
    root = target
  }

  const layout = collectLayoutReport(root, resolvedBreakpointId, nodeId)
  const screenshot = captureScreenshot
    ? await captureElementScreenshot(root)
    : unavailableScreenshot('Screenshot capture not requested.')

  return {
    breakpointId: resolvedBreakpointId,
    ...(nodeId ? { nodeId } : {}),
    label: nodeId ? `${resolvedBreakpointId} · ${nodeId}` : resolvedBreakpointId,
    width: Math.round(root.getBoundingClientRect().width),
    capturedAt: Date.now(),
    screenshot,
    layout,
  }
}

function findCanvasFrame(breakpointId?: string): HTMLElement | null {
  if (typeof document === 'undefined') return null
  if (breakpointId) {
    const exact = document.querySelector<HTMLElement>(
      `[data-breakpoint-id="${cssAttrEscape(breakpointId)}"]`,
    )
    if (exact) return exact
  }
  return document.querySelector<HTMLElement>('[data-breakpoint-id]')
}

function cssAttrEscape(value: string): string {
  // Escape attribute-value double quotes/backslashes so the selector parses.
  return value.replace(/[\\"]/g, '\\$&')
}

function collectLayoutReport(
  root: HTMLElement,
  breakpointId: string,
  nodeId?: string,
): AgentLayoutReportContext {
  const rootRect = root.getBoundingClientRect()
  const viewport = {
    width: Math.round(rootRect.width || root.clientWidth),
    height: Math.round(rootRect.height || root.clientHeight),
    scrollWidth: root.scrollWidth,
    scrollHeight: root.scrollHeight,
  }

  const warnings: AgentLayoutWarningContext[] = []
  if (root.scrollWidth > root.clientWidth + OVERFLOW_TOLERANCE_PX) {
    warnings.push({
      type: 'horizontal-overflow',
      severity: 'warning',
      message: 'The captured region has horizontal overflow.',
    })
  }
  if (root.scrollHeight > root.clientHeight + OVERFLOW_TOLERANCE_PX) {
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

  if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
    warnings.push({
      type: 'broken-image',
      severity: 'warning',
      message: 'Image is not loaded or has no natural dimensions.',
      nodeId,
    })
  }

  return image
}

async function captureElementScreenshot(root: HTMLElement): Promise<AgentScreenshotContext> {
  try {
    const { toPng } = await import('html-to-image')
    const rect = root.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return unavailableScreenshot('Captured element has no visible size.')
    }

    // Cap BOTH dimensions at MAX_IMAGE_EDGE (never upscale past 1:1). A tall
    // page is constrained by its height; a wide one by its width.
    const pixelRatio = Math.min(
      1,
      MAX_IMAGE_EDGE / Math.max(1, rect.width),
      MAX_IMAGE_EDGE / Math.max(1, rect.height),
    )
    const dataUrl = await toPng(root, {
      cacheBust: true,
      pixelRatio,
      backgroundColor: '#ffffff',
      imagePlaceholder: '',
    })
    const marker = 'base64,'
    const markerIndex = dataUrl.indexOf(marker)
    return {
      status: 'ok',
      mimeType: 'image/png',
      data: markerIndex >= 0 ? dataUrl.slice(markerIndex + marker.length) : dataUrl,
      width: Math.round(rect.width * pixelRatio),
      height: Math.round(rect.height * pixelRatio),
    }
  } catch (err) {
    return {
      status: 'error',
      error: getErrorMessage(err, 'Screenshot capture failed.'),
    }
  }
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

function round(value: number): number {
  return Math.round(value * 100) / 100
}
