/**
 * Geometry helpers that translate elements measured inside a breakpoint
 * iframe into the canvas overlay coordinate space (canvas-root-local,
 * post-transform screen px).
 *
 * `getBoundingClientRect()` inside the iframe returns un-transformed coords
 * (the iframe document is its own viewport, never transformed). The iframe
 * ELEMENT in the parent doc IS scaled by the canvas transform layer, so we
 * recover the canvas zoom from the iframe element itself
 * (`clientRect.width / offsetWidth`), multiply the inner rect by that scale,
 * add the iframe's outer offset, and subtract the canvas-root origin (zero
 * in the fixed-position fallback mode).
 */

export interface CanvasOverlayRect {
  x: number
  y: number
  width: number
  height: number
}

interface CanvasOverlayMeasureSession {
  /** Canvas-root client rect, or null in the fixed/body fallback mode. */
  canvasRect: DOMRect | null
  /** Measure one iframe element into overlay (canvas-root-local) coords. */
  measure(target: HTMLElement | null): CanvasOverlayRect | null
}

/**
 * Snapshot the geometry shared by every overlay measurement in one animation
 * frame — the iframe rect/scale and the canvas-root origin — so a tick that
 * positions K rings reads them ONCE instead of K times. Reading them in the
 * parent document before any overlay style write also keeps the tick's
 * read phase free of forced reflows (the writes happen afterwards).
 */
export function createCanvasOverlayMeasureSession(
  iframe: HTMLIFrameElement,
  canvasRoot: HTMLElement | null,
): CanvasOverlayMeasureSession {
  const iframeRect = iframe.getBoundingClientRect()
  const iframeScale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
  const canvasRect = canvasRoot ? canvasRoot.getBoundingClientRect() : null
  const originLeft = canvasRect?.left ?? 0
  const originTop = canvasRect?.top ?? 0

  return {
    canvasRect,
    measure(target) {
      // Duck-type check (`getBoundingClientRect` is callable) rather than
      // `instanceof Element` because iframe nodes have their own Element class.
      if (
        !target ||
        typeof (target as { getBoundingClientRect?: unknown }).getBoundingClientRect !== 'function'
      ) {
        return null
      }

      const elementRectInIframe = target.getBoundingClientRect()
      if (elementRectInIframe.width === 0 && elementRectInIframe.height === 0) {
        return null
      }
      return {
        x: iframeRect.left + elementRectInIframe.left * iframeScale - originLeft,
        y: iframeRect.top + elementRectInIframe.top * iframeScale - originTop,
        width: elementRectInIframe.width * iframeScale,
        height: elementRectInIframe.height * iframeScale,
      }
    },
  }
}

/**
 * One-shot convenience over `createCanvasOverlayMeasureSession` for callers
 * that measure a single element (plugin canvas hooks, tree-ladder rows).
 * Hot per-frame loops should create a session instead.
 */
export function measureCanvasElementRect(
  target: HTMLElement | null,
  iframe: HTMLIFrameElement,
  canvasRoot: HTMLElement | null,
): CanvasOverlayRect | null {
  if (!target) return null
  return createCanvasOverlayMeasureSession(iframe, canvasRoot).measure(target)
}

/** Smallest rect containing both `a` (may be null) and `b`. */
export function unionCanvasOverlayRects(
  a: CanvasOverlayRect | null,
  b: CanvasOverlayRect,
): CanvasOverlayRect {
  if (!a) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

