/**
 * Frame-scoped presence PUBLISHERS — the write side of canvas presence,
 * extracted from PeerPresenceOverlay so the overlay owns only rendering.
 *
 * Both hooks attach listeners to a breakpoint frame's iframe DOCUMENT. The
 * frame boots via `srcDoc`, which REPLACES the iframe's initial about:blank
 * document on load — listeners attached to the pre-load document die
 * silently — so both re-attach on every iframe `load` (the bug class that
 * once shipped cursor publishing dead).
 *
 *   - usePointerPresencePublisher: throttled mousemove → awareness pointer
 *     (10 Hz + deadband + trailing flush; the receive side interpolates).
 *   - useCaretPresencePublisher: selectionchange during an inline-edit
 *     session owned by this frame → awareness textCaret as Y.Text RELATIVE
 *     positions (see ./caretPositions.ts).
 */
import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { collabDocFor } from '@site/store/slices/site/collabBinding'
import {
  activeEditorDocId,
  publishLocalPointer,
  publishLocalTextCaret,
} from './awarenessState'
import { encodeCaretRange } from './caretPositions'

// Publish at 10 Hz with a movement deadband — interpolation on the receiving
// side turns the sparse samples back into smooth motion, so a lower wire
// rate costs nothing visually and saves frames for everyone.
const POINTER_PUBLISH_INTERVAL_MS = 100
const POINTER_DEADBAND_PX = 2

/**
 * Attach `setup` to the iframe's CURRENT document and re-attach on every
 * `load`. `setup` returns its own teardown for the document it attached to.
 */
function attachAcrossLoads(
  iframe: HTMLIFrameElement,
  setup: (doc: Document) => () => void,
): () => void {
  let attachedDoc: Document | null = null
  let teardown: (() => void) | null = null
  const detach = (): void => {
    teardown?.()
    teardown = null
    attachedDoc = null
  }
  const attach = (): void => {
    const doc = iframe.contentDocument
    if (!doc || doc === attachedDoc) return
    detach()
    attachedDoc = doc
    teardown = setup(doc)
  }
  attach()
  iframe.addEventListener('load', attach)
  return () => {
    iframe.removeEventListener('load', attach)
    detach()
  }
}

/** Broadcast the local mouse position over `breakpointId`'s frame. */
export function usePointerPresencePublisher(
  iframeElement: HTMLIFrameElement | null,
  breakpointId: string,
): void {
  useEffect(() => {
    const iframe = iframeElement
    if (!iframe) return undefined

    let lastSent = 0
    let lastX = Number.NaN
    let lastY = Number.NaN
    let trailing: ReturnType<typeof setTimeout> | null = null

    const publish = (x: number, y: number): void => {
      lastSent = performance.now()
      lastX = x
      lastY = y
      publishLocalPointer({ x, y, breakpointId })
    }
    const handleMove = (event: MouseEvent): void => {
      const { clientX, clientY } = event
      // Sub-deadband tremor isn't worth a frame on the wire.
      if (Math.hypot(clientX - lastX, clientY - lastY) < POINTER_DEADBAND_PX) return
      const elapsed = performance.now() - lastSent
      if (elapsed >= POINTER_PUBLISH_INTERVAL_MS) {
        if (trailing) {
          clearTimeout(trailing)
          trailing = null
        }
        publish(clientX, clientY)
        return
      }
      // Inside the throttle window: schedule ONE trailing publish so the
      // cursor's final resting position always ships (a plain leading-edge
      // throttle would drop the last sample and leave peers slightly off).
      if (trailing) clearTimeout(trailing)
      trailing = setTimeout(() => {
        trailing = null
        publish(clientX, clientY)
      }, POINTER_PUBLISH_INTERVAL_MS - elapsed)
    }
    const handleLeave = (): void => {
      if (trailing) {
        clearTimeout(trailing)
        trailing = null
      }
      lastX = Number.NaN
      lastY = Number.NaN
      publishLocalPointer(null)
    }

    const detach = attachAcrossLoads(iframe, (doc) => {
      doc.addEventListener('mousemove', handleMove)
      doc.addEventListener('mouseleave', handleLeave)
      return () => {
        doc.removeEventListener('mousemove', handleMove)
        doc.removeEventListener('mouseleave', handleLeave)
      }
    })
    return () => {
      if (trailing) clearTimeout(trailing)
      detach()
      publishLocalPointer(null)
    }
  }, [iframeElement, breakpointId])
}

/** Character offset of a DOM selection point within `root` (walk order). */
function textOffsetAtDomPosition(
  iframeDoc: Document,
  root: HTMLElement,
  node: Node,
  offset: number,
): number {
  const range = iframeDoc.createRange()
  range.setStart(root, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

/**
 * Broadcast the local caret/selection while an inline text-edit session
 * owned by `breakpointId`'s frame is active — encoded as Y.Text relative
 * positions so peers resolve the exact spot under concurrent edits.
 */
export function useCaretPresencePublisher(
  iframeElement: HTMLIFrameElement | null,
  breakpointId: string,
): void {
  useEffect(() => {
    const iframe = iframeElement
    if (!iframe) return undefined

    return attachAcrossLoads(iframe, (doc) => {
      const handleSelectionChange = (): void => {
        const store = useEditorStore.getState()
        const session = store.activeInlineEdit
        if (!session || session.breakpointId !== breakpointId) return
        const element = doc.querySelector<HTMLElement>(`[data-node-id="${session.nodeId}"]`)
        const selection = doc.getSelection()
        if (!element || !selection || selection.rangeCount === 0) return
        if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return
        const collabDoc = collabDocFor(
          activeEditorDocId({
            activeDocument: store.activeDocument,
            activePageId: store.activePageId,
          }) ?? '',
        )
        if (!collabDoc || !selection.anchorNode || !selection.focusNode) return
        const anchor = textOffsetAtDomPosition(doc, element, selection.anchorNode, selection.anchorOffset)
        const head = textOffsetAtDomPosition(doc, element, selection.focusNode, selection.focusOffset)
        publishLocalTextCaret(encodeCaretRange(collabDoc, session.nodeId, session.prop, anchor, head))
      }
      doc.addEventListener('selectionchange', handleSelectionChange)
      return () => doc.removeEventListener('selectionchange', handleSelectionChange)
    })
  }, [iframeElement, breakpointId])
}
