/**
 * Cross-iframe pointer relay signal.
 *
 * Parent-document drags cannot receive native pointermove/up events once the
 * cursor enters a breakpoint iframe. `IframeFrameSurface` reads these flags
 * from the parent document and forwards iframe pointer events back to the
 * parent window while a canvas drag is active.
 */
export function markCanvasPointerRelay(pointerId: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.instaticCanvasDragging = '1'
  document.documentElement.dataset.instaticCanvasDraggingPointerId = String(pointerId)
}

export function clearCanvasPointerRelay(): void {
  if (typeof document === 'undefined') return
  delete document.documentElement.dataset.instaticCanvasDragging
  delete document.documentElement.dataset.instaticCanvasDraggingPointerId
}
