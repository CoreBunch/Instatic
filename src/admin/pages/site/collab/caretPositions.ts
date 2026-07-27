/**
 * Caret position codec for text presence.
 *
 * A peer's caret is broadcast as Yjs RELATIVE positions (anchor + head)
 * inside the edited node's Y.Text — relative positions pin to the CRDT item
 * the caret sits next to, so they stay correct on every replica while
 * concurrent edits shift the surrounding text (a plain character index
 * would drift). Encoded to base64 for the JSON awareness state.
 *
 * Both sides no-op gracefully when the prop isn't a Y.Text (a node that has
 * never been through the collab translator stores plain values).
 */
import * as Y from 'yjs'
import { fromBase64, toBase64 } from 'lib0/buffer'
import { nodeTextOf } from '@core/collab'

export interface EncodedCaretRange {
  nodeId: string
  prop: string
  /** base64-encoded Y.RelativePosition */
  anchor: string
  head: string
}

/** Character offsets → wire-encodable relative positions. */
export function encodeCaretRange(
  doc: Y.Doc,
  nodeId: string,
  prop: string,
  anchorIndex: number,
  headIndex: number,
): EncodedCaretRange | null {
  const text = nodeTextOf(doc, nodeId, prop)
  if (!text) return null
  const clamp = (index: number) => Math.max(0, Math.min(text.length, index))
  return {
    nodeId,
    prop,
    anchor: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, clamp(anchorIndex)))),
    head: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, clamp(headIndex)))),
  }
}

/** Wire positions → character offsets in THIS replica's current text. */
export function resolveCaretRange(
  doc: Y.Doc,
  caret: EncodedCaretRange,
): { anchor: number; head: number } | null {
  const text = nodeTextOf(doc, caret.nodeId, caret.prop)
  if (!text) return null
  try {
    const anchor = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(caret.anchor)),
      doc,
    )
    const head = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(fromBase64(caret.head)),
      doc,
    )
    if (!anchor || !head || anchor.type !== text || head.type !== text) return null
    return { anchor: anchor.index, head: head.index }
  } catch {
    // Malformed wire data from a peer — treat as "no caret", never crash.
    return null
  }
}
