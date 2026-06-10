/**
 * canvasNodeLookup — the ONE way to resolve the live DOM element that renders
 * a page-tree node.
 *
 * `data-node-id` is not unique to the canvas: the DOM panel's tree rows, the
 * Import-HTML preview rows, and the selection/hover overlay rings all carry it
 * in the ADMIN document. Resolving a node by querying the admin document
 * therefore returns panel chrome whenever such an element happens to exist —
 * and whether it exists depends on transient UI state (the layers tree
 * auto-expands the selected node's ancestors AFTER selection), which made
 * ambient-selector matching in the Properties panel flicker between correct
 * and empty depending on click order.
 *
 * Canvas nodes render exclusively inside the per-breakpoint canvas iframes
 * (`IframeFrameSurface`), whose `<body>` is tagged with `data-breakpoint-id`.
 * The lookup searches ONLY those documents — never the admin document, and
 * never iframes that aren't canvas frames (plugin surfaces, previews).
 */

/** Escape a value for safe interpolation into a `[attr="…"]` CSS selector. */
export function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function findRenderedCanvasNodeElement(
  nodeId: string,
  root: Document = document,
): HTMLElement | null {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  for (const frame of root.querySelectorAll('iframe')) {
    let frameDoc: Document | null
    try {
      // Throws for cross-origin frames (a plugin or dev tool may add one to
      // the admin shell); may be null before the frame has loaded.
      frameDoc = frame.contentDocument
    } catch (_err) {
      frameDoc = null
    }
    if (!frameDoc?.body?.hasAttribute('data-breakpoint-id')) continue
    const element = frameDoc.querySelector<HTMLElement>(selector)
    if (element) return element
  }
  return null
}
