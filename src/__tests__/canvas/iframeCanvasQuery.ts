/**
 * Test helper: query for canvas-rendered DOM across breakpoint iframes.
 *
 * The canvas renders each breakpoint frame inside its own iframe (see
 * `docs/features/canvas-iframe-per-frame.md`). Tests that used to call
 * `document.querySelector('[data-node-id="..."]')` won't find anything because
 * the page tree lives in `iframe.contentDocument`. This helper hides that
 * detail by walking every canvas iframe in the test DOM and returning the
 * first match. Callers can therefore stay agnostic about whether the
 * canvas renders directly or via iframes.
 */

/**
 * Find the first element matching `selector` inside any canvas iframe (or
 * the parent document, as a fallback).
 */
export function queryCanvasElement<E extends Element = HTMLElement>(
  selector: string,
): E | null {
  // Try main document first — covers test surfaces that don't render the
  // canvas (e.g. snapshot tests of a single module preview).
  const directHit = document.querySelector<E>(selector)
  if (directHit) return directHit

  // Then each canvas iframe in turn.
  for (const iframe of allCanvasIframes()) {
    const doc = iframe.contentDocument
    if (!doc) continue
    const hit = doc.querySelector<E>(selector)
    if (hit) return hit
  }
  return null
}

/**
 * Find every element matching `selector` across all canvas iframes plus the
 * parent document. Returned in iframe-iteration order (matches the order of
 * `<iframe>` elements in the parent DOM).
 */
function queryCanvasElements<E extends Element = HTMLElement>(
  selector: string,
): E[] {
  const out: E[] = []
  out.push(...Array.from(document.querySelectorAll<E>(selector)))
  for (const iframe of allCanvasIframes()) {
    const doc = iframe.contentDocument
    if (!doc) continue
    out.push(...Array.from(doc.querySelectorAll<E>(selector)))
  }
  return out
}

/**
 * Look up a canvas iframe by its breakpoint id (matches the
 * `data-testid="canvas-frame-<id>"` wrapper that hosts the iframe).
 */
export function getCanvasFrameDocument(breakpointId: string): Document | null {
  for (const iframe of allCanvasIframes()) {
    if (iframe.contentDocument?.body?.getAttribute('data-breakpoint-id') === breakpointId) {
      return iframe.contentDocument
    }
  }
  return null
}

/**
 * Find a node in a specific breakpoint frame's iframe. Equivalent to the
 * legacy `document.querySelector('[data-breakpoint-id="X"] [data-node-id="Y"]')`
 * for callers that explicitly want one breakpoint's instance of a node.
 */
export function queryCanvasNodeInFrame<E extends Element = HTMLElement>(
  breakpointId: string,
  nodeId: string,
): E | null {
  const doc = getCanvasFrameDocument(breakpointId)
  if (!doc) return null
  return doc.querySelector<E>(`[data-node-id="${escapeAttr(nodeId)}"]`)
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '\\"')
}

function allCanvasIframes(): HTMLIFrameElement[] {
  return Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe')).filter(
    (i) => i.title.startsWith('Canvas frame for '),
  )
}
