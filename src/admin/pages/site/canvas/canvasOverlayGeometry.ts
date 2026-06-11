/**
 * Translate an element measured inside the breakpoint iframe into the canvas
 * overlay coordinate space.
 */
export function measureCanvasElementRect(
  target: HTMLElement | null,
  iframe: HTMLIFrameElement,
  canvasRoot: HTMLElement | null,
): { x: number; y: number; width: number; height: number } | null {
  // Use a duck-type check (`getBoundingClientRect` is callable) rather than
  // `instanceof Element` because iframe nodes have their own Element class.
  if (!target || typeof (target as { getBoundingClientRect?: unknown }).getBoundingClientRect !== 'function') {
    return null
  }

  const elementRectInIframe = target.getBoundingClientRect()
  if (elementRectInIframe.width === 0 && elementRectInIframe.height === 0) {
    return null
  }
  const iframeRect = iframe.getBoundingClientRect()
  const iframeScale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
  const editorDocRect = {
    left: iframeRect.left + elementRectInIframe.left * iframeScale,
    top: iframeRect.top + elementRectInIframe.top * iframeScale,
    width: elementRectInIframe.width * iframeScale,
    height: elementRectInIframe.height * iframeScale,
  }

  let originLeft = 0
  let originTop = 0
  if (canvasRoot) {
    const canvasRect = canvasRoot.getBoundingClientRect()
    originLeft = canvasRect.left
    originTop = canvasRect.top
  }
  return {
    x: editorDocRect.left - originLeft,
    y: editorDocRect.top - originTop,
    width: editorDocRect.width,
    height: editorDocRect.height,
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
