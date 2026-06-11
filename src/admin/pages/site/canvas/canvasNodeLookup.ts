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

/**
 * Per-overlay cache of nodeId → rendered element inside one breakpoint
 * iframe.
 *
 * The selection overlay's RAF tick used to `querySelector` every tracked
 * node on every frame — an O(document) attribute scan per ring at 60fps.
 * Caching the resolved element makes the steady-state tick O(1) per ring;
 * a cached entry is re-queried only when it has been unmounted
 * (`!isConnected` — e.g. the node re-rendered) or when the iframe swapped
 * documents (a srcDoc reload leaves stale elements connected to the OLD
 * document, so `ownerDocument` must match the live one).
 *
 * Call `retainOnly` with the ids tracked this tick so entries for
 * deselected nodes don't pin detached DOM subtrees in memory.
 */
export class CanvasNodeElementCache {
  private elements = new Map<string, HTMLElement>()

  resolve(doc: Document, nodeId: string): HTMLElement | null {
    const cached = this.elements.get(nodeId)
    if (cached && cached.isConnected && cached.ownerDocument === doc) return cached

    const element = doc.querySelector<HTMLElement>(
      `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`,
    )
    if (element) this.elements.set(nodeId, element)
    else this.elements.delete(nodeId)
    return element
  }

  retainOnly(nodeIds: ReadonlySet<string>): void {
    for (const id of this.elements.keys()) {
      if (!nodeIds.has(id)) this.elements.delete(id)
    }
  }
}

export function findRenderedCanvasNodeElement(
  nodeId: string,
  root: Document = document,
): HTMLElement | null {
  return findRenderedCanvasNodes(nodeId, root)[0]?.element ?? null
}

/** A rendered canvas node together with the breakpoint iframe hosting it. */
export interface RenderedCanvasNode {
  element: HTMLElement
  frame: HTMLIFrameElement
}

/**
 * Every canvas frame's rendered element for a node, in frame order — one per
 * breakpoint frame that has mounted the node, paired with its hosting iframe
 * (geometry callers need the frame for zoom/coordinate translation, and
 * `defaultView.frameElement` is not reliable in every environment).
 */
export function findRenderedCanvasNodes(
  nodeId: string,
  root: Document = document,
): RenderedCanvasNode[] {
  const selector = `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`
  const nodes: RenderedCanvasNode[] = []
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
    if (element) nodes.push({ element, frame })
  }
  return nodes
}
