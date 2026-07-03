/**
 * PeerPresenceOverlay — live "who's doing what" chrome for co-editing.
 *
 * One overlay per breakpoint frame, mounted next to
 * `BreakpointSelectionOverlay` and reusing its architecture: rings are
 * portaled into the canvas root (screen-px space — the 1.5px peer ring stays
 * crisp at every zoom), tracked elements resolve via `[data-node-id]` inside
 * the frame's iframe, and a RAF loop repositions everything through one
 * shared measure session per tick.
 *
 * Renders, per peer on the SAME doc:
 *   - a selection ring around each of the peer's selected nodes,
 *   - a name-tag chip above the first ring (marked ✎ during the peer's
 *     inline text-edit session),
 *   - a pointer dot inside the frame the peer's cursor is over.
 *
 * This component also PUBLISHES the local pointer for its frame (throttled
 * mousemove on the iframe document) — presence is symmetric, so the reader
 * and the writer live in the same mount.
 *
 * All colors flow through the `--peer-color` inline custom property
 * (deterministic identity HSL from the user id — see awarenessState.ts).
 */
import { use, useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { CursorMinimalSolidIcon } from 'pixel-art-icons/icons/cursor-minimal-solid'
import { Tooltip } from '@ui/components/Tooltip'
import { PeerAvatar } from '@site/collab/PeerAvatar'
import { useEditorStore } from '@site/store/store'
import {
  activeEditorDocId,
  publishLocalPointer,
  publishLocalTextCaret,
  usePeerPresences,
  type PeerPresence,
} from '@site/collab/awarenessState'
import { encodeCaretRange, resolveCaretRange } from '@site/collab/caretPositions'
import { collabDocFor } from '@site/store/slices/site/collabBinding'
import { CanvasViewportActionsContext } from './CanvasContexts'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import { createCanvasOverlayMeasureSession } from './canvasOverlayGeometry'
import { hideOverlayElement, positionOverlayElement } from './canvasSelectionOverlayPositioning'
import styles from './PeerPresenceOverlay.module.css'

// Publish at 10 Hz with a movement deadband — interpolation on the receiving
// side (below) turns the sparse samples back into smooth motion, so a lower
// wire rate COSTS nothing visually and saves frames for everyone.
const POINTER_PUBLISH_INTERVAL_MS = 100
const POINTER_DEADBAND_PX = 2

// Receive-side smoothing: each frame the rendered cursor eases toward the
// last received target with an exponential time constant. ~TAU ms closes 63%
// of the remaining gap; visually settled in ~3×TAU.
const POINTER_SMOOTHING_TAU_MS = 90
// A jump larger than this teleports instead of gliding across the canvas
// (peer re-entered the frame somewhere else entirely).
const POINTER_SNAP_DISTANCE_PX = 400

// Exit debounce: when a peer's cursor leaves this frame, hold it in place
// for the grace period (skimming a frame edge must not flicker), THEN let
// the CSS opacity transition fade it out. Re-entering within the window
// cancels the fade and glides from the held position.
const POINTER_LINGER_MS = 250
// Keep the frozen position around long enough for the fade to finish.
const POINTER_FADE_STATE_MS = 700

/**
 * Point chrome (name tag, pointer dot) sizes itself from content — position
 * with transform only, never width/height. `lift` raises the element above
 * the anchor point (name tag sits on top of the ring's upper edge).
 */
function positionPointElement(
  element: HTMLElement | null,
  point: { x: number; y: number } | null,
  lift = false,
): void {
  if (!element) return
  if (!point) {
    element.style.display = 'none'
    return
  }
  element.style.display = ''
  element.style.transform = `translate(${point.x}px, ${point.y}px)${lift ? ' translateY(-100%)' : ''}`
}

interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

/** Resolve the DOM position `offset` characters into `root`'s text. */
function domPositionAtTextOffset(
  iframeDoc: Document,
  root: HTMLElement,
  offset: number,
): { node: Node; offset: number } {
  const walker = iframeDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let last: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const length = text.data.length
    if (remaining <= length) return { node: text, offset: remaining }
    remaining -= length
    last = text
  }
  return last ? { node: last, offset: last.data.length } : { node: root, offset: 0 }
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

/** Sync `container`'s children to one absolutely-positioned div per rect. */
function syncHighlightRects(container: HTMLElement | null, rects: OverlayRect[]): void {
  if (!container) return
  while (container.children.length > rects.length) container.lastElementChild?.remove()
  while (container.children.length < rects.length) {
    container.appendChild(container.ownerDocument.createElement('div'))
  }
  for (let i = 0; i < rects.length; i++) {
    const el = container.children[i] as HTMLElement
    const rect = rects[i]
    el.style.position = 'absolute'
    el.style.transform = `translate(${rect.x}px, ${rect.y}px)`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
  }
}

interface PeerPresenceOverlayProps {
  breakpointId: string
  iframeElement: HTMLIFrameElement | null
}

function ringKey(peer: PeerPresence, nodeId: string): string {
  return `${peer.clientId}:${nodeId}`
}

export function PeerPresenceOverlay({ breakpointId, iframeElement }: PeerPresenceOverlayProps) {
  const docId = useEditorStore((s) =>
    activeEditorDocId({ activeDocument: s.activeDocument, activePageId: s.activePageId }),
  )
  const peers = usePeerPresences(docId)
  const viewportActions = use(CanvasViewportActionsContext)
  const [portalCanvasRoot, setPortalCanvasRoot] = useState<HTMLElement | null>(null)

  const ringRefs = useRef<Map<string, HTMLDivElement | null> | null>(null)
  if (ringRefs.current === null) ringRefs.current = new Map()
  const tagRefs = useRef<Map<number, HTMLDivElement | null> | null>(null)
  if (tagRefs.current === null) tagRefs.current = new Map()
  const pointerRefs = useRef<Map<number, HTMLDivElement | null> | null>(null)
  if (pointerRefs.current === null) pointerRefs.current = new Map()
  const caretRefs = useRef<Map<number, HTMLDivElement | null> | null>(null)
  if (caretRefs.current === null) caretRefs.current = new Map()
  const highlightRefs = useRef<Map<number, HTMLDivElement | null> | null>(null)
  if (highlightRefs.current === null) highlightRefs.current = new Map()
  const nodeElementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeElementCacheRef.current === null) nodeElementCacheRef.current = new CanvasNodeElementCache()
  /** clientId → rendered cursor position (easing toward the last target)
   *  plus when this frame last owned the pointer — drives the exit linger. */
  const animatedPointersRef = useRef<Map<number, { x: number; y: number; lastSeenAt: number }> | null>(null)
  if (animatedPointersRef.current === null) animatedPointersRef.current = new Map()
  const lastTickAtRef = useRef(0)

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = viewportActions?.canvasRootRef.current ?? null
      setPortalCanvasRoot((current) => (current === root ? current : root))
    })
    return () => cancelAnimationFrame(frame)
  }, [viewportActions])

  // ── Local pointer publisher (this frame) ─────────────────────────────────
  // The frame boots via `srcDoc`, which REPLACES the iframe's initial
  // about:blank document on load — listeners attached to the pre-load
  // document die silently. Attach to the CURRENT document and re-attach on
  // every `load` so the publisher survives the swap (and any reload).
  useEffect(() => {
    const iframe = iframeElement
    if (!iframe) return undefined

    let attachedDoc: Document | null = null
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
    const detach = (): void => {
      attachedDoc?.removeEventListener('mousemove', handleMove)
      attachedDoc?.removeEventListener('mouseleave', handleLeave)
      attachedDoc = null
    }
    const attach = (): void => {
      const doc = iframe.contentDocument
      if (!doc || doc === attachedDoc) return
      detach()
      attachedDoc = doc
      doc.addEventListener('mousemove', handleMove)
      doc.addEventListener('mouseleave', handleLeave)
    }

    attach()
    iframe.addEventListener('load', attach)
    return () => {
      iframe.removeEventListener('load', attach)
      if (trailing) clearTimeout(trailing)
      detach()
      publishLocalPointer(null)
    }
  }, [iframeElement, breakpointId])

  // ── Local text-caret publisher (this frame) ──────────────────────────────
  // During an inline-edit session owned by THIS frame, every selection
  // change publishes the caret as Y.Text RELATIVE positions — pinned to the
  // CRDT items around the caret, so peers resolve the right spot even while
  // concurrent edits shift the text (see collab/caretPositions.ts).
  useEffect(() => {
    const iframe = iframeElement
    if (!iframe) return undefined

    let attachedDoc: Document | null = null
    const handleSelectionChange = (): void => {
      const store = useEditorStore.getState()
      const session = store.activeInlineEdit
      if (!session || session.breakpointId !== breakpointId) return
      const doc = attachedDoc
      if (!doc) return
      const element = doc.querySelector<HTMLElement>(`[data-node-id="${session.nodeId}"]`)
      const selection = doc.getSelection()
      if (!element || !selection || selection.rangeCount === 0) return
      if (!element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return
      const collabDoc = collabDocFor(
        activeEditorDocId({ activeDocument: store.activeDocument, activePageId: store.activePageId }) ?? '',
      )
      if (!collabDoc || !selection.anchorNode || !selection.focusNode) return
      const anchor = textOffsetAtDomPosition(doc, element, selection.anchorNode, selection.anchorOffset)
      const head = textOffsetAtDomPosition(doc, element, selection.focusNode, selection.focusOffset)
      publishLocalTextCaret(encodeCaretRange(collabDoc, session.nodeId, session.prop, anchor, head))
    }
    const detach = (): void => {
      attachedDoc?.removeEventListener('selectionchange', handleSelectionChange)
      attachedDoc = null
    }
    const attach = (): void => {
      const doc = iframe.contentDocument
      if (!doc || doc === attachedDoc) return
      detach()
      attachedDoc = doc
      doc.addEventListener('selectionchange', handleSelectionChange)
    }

    attach()
    iframe.addEventListener('load', attach)
    return () => {
      iframe.removeEventListener('load', attach)
      detach()
    }
  }, [iframeElement, breakpointId])

  // ── Peer chrome positioning (RAF, read-then-write like the selection overlay) ──
  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null) => {
    const iframeDoc = iframe?.contentDocument ?? null
    const elementCache = nodeElementCacheRef.current!

    if (!iframe || !iframeDoc) {
      for (const [, ring] of ringRefs.current ?? []) hideOverlayElement(ring)
      for (const [, tag] of tagRefs.current ?? []) positionPointElement(tag, null)
      for (const [, dot] of pointerRefs.current ?? []) positionPointElement(dot, null)
      return
    }

    const session = createCanvasOverlayMeasureSession(iframe, portalCanvasRoot)
    // Iframe-viewport point → canvas-root scroll-content coords (same math
    // the session applies to element rects).
    const iframeRect = iframe.getBoundingClientRect()
    const iframeScale = iframe.offsetWidth > 0 ? iframeRect.width / iframe.offsetWidth : 1
    const originLeft = (session.canvasRect?.left ?? 0) - session.scrollLeft
    const originTop = (session.canvasRect?.top ?? 0) - session.scrollTop

    // Time-based smoothing factor — frame-rate independent (a dropped frame
    // eases a proportionally larger step, so motion speed stays constant).
    const now = performance.now()
    const dt = lastTickAtRef.current === 0 ? 16 : Math.min(100, now - lastTickAtRef.current)
    lastTickAtRef.current = now
    const ease = 1 - Math.exp(-dt / POINTER_SMOOTHING_TAU_MS)
    const animated = animatedPointersRef.current!

    const trackedIds = new Set<string>()
    const ringPlacements: Array<{ element: HTMLDivElement | null; rect: ReturnType<typeof session.measure> }> = []
    const pointPlacements: Array<{ element: HTMLDivElement | null; point: { x: number; y: number } | null; lift: boolean }> = []

    for (const peer of peers) {
      let firstRect: ReturnType<typeof session.measure> = null
      for (const nodeId of peer.selectedNodeIds) {
        trackedIds.add(nodeId)
        const rect = session.measure(elementCache.resolve(iframeDoc, nodeId))
        ringPlacements.push({ element: ringRefs.current?.get(ringKey(peer, nodeId)) ?? null, rect })
        if (!firstRect && rect) firstRect = rect
      }
      pointPlacements.push({
        element: tagRefs.current?.get(peer.clientId) ?? null,
        point: firstRect ? { x: firstRect.x, y: firstRect.y } : null,
        lift: true,
      })
      const pointer = peer.pointer && peer.pointer.breakpointId === breakpointId ? peer.pointer : null
      const pointerElement = pointerRefs.current?.get(peer.clientId) ?? null
      const previous = animated.get(peer.clientId)
      if (pointer) {
        const target = {
          x: iframeRect.left + pointer.x * iframeScale - originLeft,
          y: iframeRect.top + pointer.y * iframeScale - originTop,
        }
        // Ease toward the sparse network samples every frame — the cursor
        // GLIDES between 10 Hz targets instead of teleporting. Snap on first
        // appearance and on jumps too large to glide believably.
        const next =
          !previous || Math.hypot(target.x - previous.x, target.y - previous.y) > POINTER_SNAP_DISTANCE_PX
            ? target
            : {
                x: previous.x + (target.x - previous.x) * ease,
                y: previous.y + (target.y - previous.y) * ease,
              }
        animated.set(peer.clientId, { ...next, lastSeenAt: now })
        if (pointerElement) pointerElement.dataset.visible = 'true'
        pointPlacements.push({ element: pointerElement, point: next, lift: false })
      } else if (previous) {
        // The cursor just left this frame: hold its last position through
        // the linger window (no flicker while skimming an edge), then flip
        // the attribute so the CSS opacity transition fades it out in place.
        const sinceSeen = now - previous.lastSeenAt
        if (pointerElement && sinceSeen > POINTER_LINGER_MS) pointerElement.dataset.visible = 'false'
        if (sinceSeen > POINTER_FADE_STATE_MS) {
          animated.delete(peer.clientId)
        } else {
          pointPlacements.push({ element: pointerElement, point: previous, lift: false })
        }
      } else if (pointerElement) {
        pointerElement.dataset.visible = 'false'
      }

      // ── Peer text caret + selection highlight ────────────────────────────
      const caretElement = caretRefs.current?.get(peer.clientId) ?? null
      const highlightContainer = highlightRefs.current?.get(peer.clientId) ?? null
      let caretRect: OverlayRect | null = null
      let highlightRects: OverlayRect[] = []
      if (peer.textCaret) {
        const collabDoc = collabDocFor(docId ?? '')
        const range = collabDoc ? resolveCaretRange(collabDoc, peer.textCaret) : null
        const element = range ? elementCache.resolve(iframeDoc, peer.textCaret.nodeId) : null
        if (range && element) {
          trackedIds.add(peer.textCaret.nodeId)
          const toOverlayRect = (r: DOMRect): OverlayRect => ({
            x: iframeRect.left + r.left * iframeScale - originLeft,
            y: iframeRect.top + r.top * iframeScale - originTop,
            width: r.width * iframeScale,
            height: r.height * iframeScale,
          })
          const head = domPositionAtTextOffset(iframeDoc, element, range.head)
          const headRange = iframeDoc.createRange()
          headRange.setStart(head.node, head.offset)
          headRange.collapse(true)
          const headRect = headRange.getClientRects()[0] ?? headRange.getBoundingClientRect()
          if (headRect.height > 0 || headRect.width > 0) {
            caretRect = { ...toOverlayRect(headRect), width: Math.max(1.5, 2 * iframeScale) }
          }
          if (range.anchor !== range.head) {
            const start = domPositionAtTextOffset(iframeDoc, element, Math.min(range.anchor, range.head))
            const end = domPositionAtTextOffset(iframeDoc, element, Math.max(range.anchor, range.head))
            const selectionRange = iframeDoc.createRange()
            selectionRange.setStart(start.node, start.offset)
            selectionRange.setEnd(end.node, end.offset)
            highlightRects = [...selectionRange.getClientRects()].slice(0, 24).map(toOverlayRect)
          }
        }
      }
      positionOverlayElement(caretElement, caretRect)
      syncHighlightRects(highlightContainer, highlightRects)
    }
    elementCache.retainOnly(trackedIds)

    for (const { element, rect } of ringPlacements) positionOverlayElement(element, rect)
    for (const { element, point, lift } of pointPlacements) positionPointElement(element, point, lift)
  })

  // Any peer on this doc keeps the loop alive — exit lingers and opacity
  // fades must complete even after the pointer/selection state goes empty
  // (an idle tick is a handful of map lookups; the loop still stops
  // entirely when you're alone).
  const hasPresenceWork = peers.length > 0

  useEffect(() => {
    if (!hasPresenceWork) return undefined

    let frame = 0
    let cancelled = false
    const tick = (): void => {
      if (cancelled) return
      tickOnce(iframeElement)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [hasPresenceWork, iframeElement])

  if (!hasPresenceWork) return null

  const chrome = (
    <div className={styles.presenceLayer} aria-hidden="true" data-peer-presence-layer="true">
      {peers.map((peer) => {
        const peerStyle = { '--peer-color': peer.user.color } as CSSProperties
        return (
          <div key={peer.clientId} style={peerStyle}>
            {peer.selectedNodeIds.map((nodeId) => (
              <div
                key={ringKey(peer, nodeId)}
                ref={(el) => {
                  if (el) ringRefs.current?.set(ringKey(peer, nodeId), el)
                  else ringRefs.current?.delete(ringKey(peer, nodeId))
                }}
                className={styles.ring}
                data-peer-selection-ring="true"
              />
            ))}
            {peer.selectedNodeIds.length > 0 && (
              <div
                ref={(el) => {
                  if (el) tagRefs.current?.set(peer.clientId, el)
                  else tagRefs.current?.delete(peer.clientId)
                }}
                className={styles.nameTag}
                data-peer-name-tag="true"
                data-editing={peer.editingNodeId !== null ? 'true' : undefined}
              >
                <PeerAvatar user={peer.user} size={14} ring={false} />
                {peer.user.name}
                {peer.editingNodeId !== null && <span aria-hidden="true">✎</span>}
              </div>
            )}
            {/* Peer caret + selection highlight inside the text they are
                editing — positioned imperatively by the RAF tick. */}
            <div
              ref={(el) => {
                if (el) caretRefs.current?.set(peer.clientId, el)
                else caretRefs.current?.delete(peer.clientId)
              }}
              className={styles.caret}
              data-peer-caret="true"
            />
            <div
              ref={(el) => {
                if (el) highlightRefs.current?.set(peer.clientId, el)
                else highlightRefs.current?.delete(peer.clientId)
              }}
              className={styles.caretHighlights}
              data-peer-caret-highlights="true"
            />
            {/* Always mounted (per frame): visibility is opacity-driven by
                the RAF tick so entry/exit fade instead of popping. */}
            <div
              ref={(el) => {
                if (el) pointerRefs.current?.set(peer.clientId, el)
                else pointerRefs.current?.delete(peer.clientId)
              }}
              className={styles.pointer}
              data-peer-pointer="true"
            >
              {/* Same pixel cursor glyph the editor uses elsewhere, tinted
                  with the peer's identity color. */}
              <span className={styles.pointerIcon} aria-hidden="true">
                <CursorMinimalSolidIcon size={16} color="var(--peer-color)" />
              </span>
              {/* The identity avatar rides just under the cursor tip —
                  hover it (pointer-events re-enabled while visible) for the name. */}
              <Tooltip content={peer.user.name}>
                <PeerAvatar user={peer.user} size={18} className={styles.pointerAvatar} />
              </Tooltip>
            </div>
          </div>
        )
      })}
    </div>
  )

  return createPortal(chrome, portalCanvasRoot ?? document.body)
}
