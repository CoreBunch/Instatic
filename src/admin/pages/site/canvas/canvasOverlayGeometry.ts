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
