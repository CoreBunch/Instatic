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

export interface CanvasOverlayMeasureSession {
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

/** Typography lengths that must shrink/grow with the canvas zoom. */
const SCALED_TYPOGRAPHY_PROPS = ['font-size', 'line-height', 'letter-spacing'] as const

/** Typography that transfers verbatim from the measured element. */
const COPIED_TYPOGRAPHY_PROPS = [
  'font-family',
  'font-weight',
  'font-style',
  'color',
  'text-align',
  'text-transform',
] as const

/**
 * Scale a computed CSS px length by the iframe zoom factor. Keywords
 * (`normal`), unitless values, and non-px units pass through untouched —
 * getComputedStyle resolves lengths to px in browsers, so anything else is
 * already zoom-independent for our purposes.
 */
export function scaleCssLength(value: string, scale: number): string {
  const match = /^(-?\d*\.?\d+)px$/.exec(value.trim())
  if (!match) return value
  return `${Number.parseFloat(match[1]) * scale}px`
}

/**
 * Mirror the edited element's live typography onto the parent-document
 * inline-edit field, so the floating <textarea>/<input> reads as the text
 * it replaces. Reads through `iframe.contentWindow.getComputedStyle` (the
 * frames are same-origin `srcdoc` iframes) and scales px lengths by the
 * iframe zoom factor — the field lives in UNSCALED parent coordinates.
 *
 * NOTE: this is why the hide-doubled-text rule uses
 * `-webkit-text-fill-color: transparent` and not `color: transparent` —
 * the computed `color` read here must stay the authored color.
 */
export function mirrorInlineEditTypography(
  field: HTMLElement,
  target: HTMLElement,
  iframe: HTMLIFrameElement,
): void {
  const view = iframe.contentWindow
  if (!view) return
  const computed = view.getComputedStyle(target)
  const iframeScale =
    iframe.offsetWidth > 0 ? iframe.getBoundingClientRect().width / iframe.offsetWidth : 1
  for (const prop of SCALED_TYPOGRAPHY_PROPS) {
    field.style.setProperty(prop, scaleCssLength(computed.getPropertyValue(prop), iframeScale))
  }
  for (const prop of COPIED_TYPOGRAPHY_PROPS) {
    field.style.setProperty(prop, computed.getPropertyValue(prop))
  }
}
