/**
 * Remote merge into the inline-edit surface — what makes co-typing ONE text
 * node actually work.
 *
 * The inline editor is a contentEditable that React does not own: it is
 * seeded once at session start and every keystroke commits the element's
 * WHOLE string (`applyInlineEditValue` → `applyTextDiff`). That snapshot
 * model is only sound while the surface tracks the document. If a peer's
 * characters land in the Y.Text mid-session and never reach the frozen
 * surface, the next local keystroke's snapshot diff silently DELETES them
 * from the CRDT — every replica converges to text missing the peer's edit.
 *
 * So, for the session's lifetime, this module observes the edited prop's
 * Y.Text and folds every non-local change into the DOM: rewrite the content
 * through the same writer that seeded it, then restore the local caret at an
 * index transformed through the Yjs delta (the same association rule as
 * Y relative positions: an insert AT the caret pushes it right). During IME
 * composition the rewrite is deferred to `compositionend` — mutating the DOM
 * mid-composition breaks the IME transaction — and the caret then transforms
 * through a synthesized single-splice delta instead.
 */
import * as Y from 'yjs'
import { LOCAL_ORIGIN, SEED_ORIGIN, nodeTextOf, treeMap } from '@core/collab'
import {
  readInlineEditableText,
  seedInlineEditableContent,
} from '@modules/base/shared/inlineText'

/** One op of a Y.TextEvent delta (Yjs types it loosely; embeds count as 1). */
interface TextDeltaOp {
  retain?: number
  insert?: string | object
  delete?: number
}

/**
 * Map a character index in the PRE-change text to the equivalent index in
 * the POST-change text. Insert-at-caret pushes the caret right — matching
 * `Y.createRelativePositionFromTypeIndex`'s default association, so a peer
 * typing exactly at your caret produces the same interleaving a relative
 * position would.
 */
export function transformIndexThroughTextDelta(
  delta: readonly TextDeltaOp[],
  index: number,
): number {
  let oldPos = 0
  let out = index
  for (const op of delta) {
    if (oldPos > index) break
    if (typeof op.retain === 'number') {
      oldPos += op.retain
    } else if (typeof op.delete === 'number') {
      if (oldPos < index) out -= Math.min(op.delete, index - oldPos)
      oldPos += op.delete
    } else if (op.insert !== undefined) {
      const length = typeof op.insert === 'string' ? op.insert.length : 1
      if (oldPos <= index) out += length
    }
  }
  return Math.max(0, out)
}

/** Synthesize the minimal single-splice delta turning `from` into `to` —
 * the caret-transform fallback when no real Yjs delta is available
 * (composition-deferred merges). Same prefix/suffix walk as applyTextDiff. */
function spliceDelta(from: string, to: string): TextDeltaOp[] {
  if (from === to) return []
  let prefix = 0
  const maxPrefix = Math.min(from.length, to.length)
  while (prefix < maxPrefix && from[prefix] === to[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(from.length, to.length) - prefix
  while (
    suffix < maxSuffix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix++
  }
  const ops: TextDeltaOp[] = []
  if (prefix > 0) ops.push({ retain: prefix })
  const deleteCount = from.length - prefix - suffix
  if (deleteCount > 0) ops.push({ delete: deleteCount })
  const inserted = to.slice(prefix, to.length - suffix)
  if (inserted.length > 0) ops.push({ insert: inserted })
  return ops
}

const TEXT_NODE = 3

function isBr(node: Node): boolean {
  return node.nodeName === 'BR'
}

/** Character length of a DOM subtree in the surface's text coordinates
 * (text content, `<br>` = 1 — the `\n` it renders as). */
function textLengthOf(node: Node): number {
  if (node.nodeType === TEXT_NODE) return (node as Text).length
  if (isBr(node)) return 1
  let total = 0
  for (const child of Array.from(node.childNodes)) total += textLengthOf(child)
  return total
}

/** Absolute text offset of a DOM position inside `el`, or null when the
 * position sits outside `el`. Element-anchored positions count child index. */
function textOffsetWithin(el: HTMLElement, container: Node, offset: number): number | null {
  if (container !== el && !el.contains(container)) return null
  let acc = 0
  const walk = (node: Node): boolean => {
    if (node === container) {
      if (node.nodeType === TEXT_NODE) {
        acc += offset
      } else {
        const children = node.childNodes
        const upTo = Math.min(offset, children.length)
        for (let i = 0; i < upTo; i++) acc += textLengthOf(children[i])
      }
      return true
    }
    if (node.nodeType === TEXT_NODE) {
      acc += (node as Text).length
      return false
    }
    if (isBr(node)) {
      acc += 1
      return false
    }
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }
  return walk(el) ? acc : null
}

/** DOM position for an absolute text offset inside `el` (clamps to the end). */
function domPositionAt(el: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = Math.max(0, target)
  const find = (parent: Node): { node: Node; offset: number } | null => {
    const children = Array.from(parent.childNodes)
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.nodeType === TEXT_NODE) {
        const length = (child as Text).length
        if (remaining <= length) return { node: child, offset: remaining }
        remaining -= length
      } else if (isBr(child)) {
        if (remaining === 0) return { node: parent, offset: i }
        remaining -= 1
      } else {
        const inner = find(child)
        if (inner) return inner
      }
    }
    return null
  }
  return find(el) ?? { node: el, offset: el.childNodes.length }
}

/**
 * Keep a live inline-edit surface merged with its Y.Text for the session's
 * lifetime. Attach on session start, call the returned detach on session end.
 * No-ops (returns a no-op detach) when the prop is not stored as Y.Text — a
 * doc that has never been through the collab translator merges whole-value.
 */
export function attachInlineEditRemoteMerge(options: {
  el: HTMLElement
  doc: Y.Doc
  nodeId: string
  prop: string
  onInvalidated?: () => void
}): () => void {
  const { el, doc, nodeId, prop, onInvalidated } = options
  if (!nodeTextOf(doc, nodeId, prop)) return () => {}

  let composing = false
  let deferredWhileComposing = false
  let invalidated = false

  const mergeIntoSurface = (nextValue: string, delta: readonly TextDeltaOp[]): void => {
    if (readInlineEditableText(el) === nextValue) return

    const view = el.ownerDocument.defaultView
    const selection = view?.getSelection() ?? null
    let anchor: number | null = null
    let head: number | null = null
    if (selection && selection.rangeCount > 0 && selection.anchorNode && selection.focusNode) {
      anchor = textOffsetWithin(el, selection.anchorNode, selection.anchorOffset)
      head = textOffsetWithin(el, selection.focusNode, selection.focusOffset)
    }

    seedInlineEditableContent(el, nextValue)

    if (selection && anchor !== null && head !== null) {
      const nextAnchor = domPositionAt(el, transformIndexThroughTextDelta(delta, anchor))
      const nextHead = domPositionAt(el, transformIndexThroughTextDelta(delta, head))
      try {
        selection.setBaseAndExtent(
          nextAnchor.node,
          nextAnchor.offset,
          nextHead.node,
          nextHead.offset,
        )
      } catch {
        // Selection restore is cosmetic — the merged text is already safe.
        // A collapsed-caret fallback beats throwing out of a Y observer.
        const range = el.ownerDocument.createRange()
        range.setStart(nextHead.node, nextHead.offset)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  const observer = (
    events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ): void => {
    // Local edits are already in the DOM (the DOM is where they came from);
    // seeds mirror content the session was opened on.
    if (transaction.origin === LOCAL_ORIGIN || transaction.origin === SEED_ORIGIN) return
    const text = nodeTextOf(doc, nodeId, prop)
    if (!text) {
      if (!invalidated) {
        invalidated = true
        onInvalidated?.()
      }
      return
    }
    invalidated = false
    if (composing) {
      deferredWhileComposing = true
      return
    }
    const matchingEvent = events.find(
      (event) => event instanceof Y.YTextEvent && event.target === text,
    )
    const textEvent = matchingEvent instanceof Y.YTextEvent ? matchingEvent : null
    const currentSurface = readInlineEditableText(el)
    const nextValue = text.toString()
    mergeIntoSurface(
      nextValue,
      textEvent
        ? textEvent.delta as readonly TextDeltaOp[]
        : spliceDelta(currentSurface, nextValue),
    )
  }

  const onCompositionStart = (): void => {
    composing = true
  }
  const onCompositionEnd = (): void => {
    composing = false
    if (!deferredWhileComposing) return
    deferredWhileComposing = false
    const text = nodeTextOf(doc, nodeId, prop)
    if (!text) {
      if (!invalidated) {
        invalidated = true
        onInvalidated?.()
      }
      return
    }
    // No single Yjs delta covers the deferred window — synthesize the splice
    // between what the surface shows and what the doc now holds.
    const nextValue = text.toString()
    mergeIntoSurface(nextValue, spliceDelta(readInlineEditableText(el), nextValue))
  }

  const tree = treeMap(doc)
  // Observe the tree rather than one Y.Text instance. A whole-node remote
  // write replaces the node map and its nested Y.Text; observing only the old
  // instance silently froze the editing surface after that replacement.
  tree.observeDeep(observer)
  el.addEventListener('compositionstart', onCompositionStart)
  el.addEventListener('compositionend', onCompositionEnd)
  return () => {
    tree.unobserveDeep(observer)
    el.removeEventListener('compositionstart', onCompositionStart)
    el.removeEventListener('compositionend', onCompositionEnd)
  }
}
