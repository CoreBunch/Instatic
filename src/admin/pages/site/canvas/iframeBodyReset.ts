/**
 * Per-frame iframe document reset + canvas-chrome stylesheet.
 *
 * Every breakpoint frame renders into its own iframe document
 * (IframeFrameSurface). This module owns what happens to that document's
 * `<html>`/`<body>` when the frame (re)connects: the height/overflow reset
 * that lets design frames grow to their content on the parent canvas, and
 * the canvas-only chrome stylesheet that neutralises interaction
 * affordances inside design frames. Live frames get neither — they behave
 * exactly like the published site.
 */
import { CANVAS_VIEWPORT_HEIGHT } from './resolveViewportUnits'

/**
 * Frame interaction model.
 * - 'canvas': the infinite-surface design frame. Wheel/pointer events are
 *   forwarded to the parent for pan/zoom, the iframe grows to its content
 *   height (no inner scrollbar), and the canvas-chrome CSS neutralises
 *   cursors / text selection so the frame reads as a click-to-select preview.
 * - 'live': a single real-size frame. The iframe is its own scroll viewport
 *   (published height behaviour), real cursors and text selection apply, and
 *   no events are forwarded — there is nothing to pan.
 */
export type IframeInteraction = 'canvas' | 'live'

// Canvas-only chrome: neutralize interaction affordances inside design frames.
// Kept at module scope so the React Compiler does not treat the cross-frame
// DOM writes as React-owned state mutation.
const CANVAS_CHROME_CSS = [
  '*, *::before, *::after {',
  '  cursor: default !important;',
  '  user-select: none !important;',
  '  -webkit-user-select: none !important;',
  '  -webkit-tap-highlight-color: transparent !important;',
  '}',
  // The inline text editor IS a real element in the frame. Restore text
  // selection + the I-beam on it (and its descendants) so the author can click
  // to place the caret, double-click a word, and drag-select while editing.
  '[contenteditable], [contenteditable] * {',
  '  cursor: text !important;',
  '  user-select: text !important;',
  '  -webkit-user-select: text !important;',
  '}',
  '*:focus, *:focus-visible {',
  '  outline: none !important;',
  '}',
  'iframe { pointer-events: none; }',
].join('\n')

export function applyIframeBodyReset(
  iframeDoc: Document,
  breakpointId: string,
  interaction: IframeInteraction,
): void {
  iframeDoc.body.setAttribute('data-breakpoint-id', breakpointId)
  // Live frames render the page exactly as published: html/body keep the
  // `:where(html, body) { height: 100% }` reset (the iframe is the scroll
  // viewport, short pages still fill it), and the canvas-chrome CSS
  // (cursor / user-select / nested-iframe overrides) is NOT applied — real
  // cursors, text selection, and embedded iframes behave like the live site.
  if (interaction === 'live') {
    iframeDoc.documentElement.style.height = ''
    iframeDoc.body.style.height = ''
    iframeDoc.body.style.minHeight = ''
    iframeDoc.documentElement.style.overflow = ''
    iframeDoc.body.style.overflow = ''
    return
  }
  iframeDoc.documentElement.style.height = 'auto'
  iframeDoc.body.style.height = 'auto'
  iframeDoc.body.style.minHeight = `${CANVAS_VIEWPORT_HEIGHT}px`
  // Design frames grow to fit their content on the parent canvas. The iframe
  // document itself must never expose root scrollbars while that fit settles
  // or because authored CSS sets html/body overflow.
  iframeDoc.documentElement.style.overflow = 'hidden'
  iframeDoc.body.style.overflow = 'hidden'
  let chrome = iframeDoc.head.querySelector('style[data-instatic-canvas-chrome]')
  if (!chrome) {
    chrome = iframeDoc.createElement('style')
    chrome.setAttribute('data-instatic-canvas-chrome', '')
    chrome.textContent = CANVAS_CHROME_CSS
    iframeDoc.head.appendChild(chrome)
  }
}
