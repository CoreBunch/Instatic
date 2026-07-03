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
import { useEditorStore } from '@site/store/store'
import {
  activeEditorDocId,
  publishLocalPointer,
  usePeerPresences,
  type PeerPresence,
} from '@site/collab/awarenessState'
import { CanvasViewportActionsContext } from './CanvasContexts'
import { CanvasNodeElementCache } from './canvasNodeLookup'
import { createCanvasOverlayMeasureSession } from './canvasOverlayGeometry'
import { hideOverlayElement, positionOverlayElement } from './canvasSelectionOverlayPositioning'
import styles from './PeerPresenceOverlay.module.css'

const POINTER_PUBLISH_INTERVAL_MS = 66 // ~15 Hz

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
  const nodeElementCacheRef = useRef<CanvasNodeElementCache | null>(null)
  if (nodeElementCacheRef.current === null) nodeElementCacheRef.current = new CanvasNodeElementCache()

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
    const handleMove = (event: MouseEvent): void => {
      const now = performance.now()
      if (now - lastSent < POINTER_PUBLISH_INTERVAL_MS) return
      lastSent = now
      publishLocalPointer({ x: event.clientX, y: event.clientY, breakpointId })
    }
    const handleLeave = (): void => {
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
      detach()
      publishLocalPointer(null)
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
      pointPlacements.push({
        element: pointerRefs.current?.get(peer.clientId) ?? null,
        point: pointer
          ? {
              x: iframeRect.left + pointer.x * iframeScale - originLeft,
              y: iframeRect.top + pointer.y * iframeScale - originTop,
            }
          : null,
        lift: false,
      })
    }
    elementCache.retainOnly(trackedIds)

    for (const { element, rect } of ringPlacements) positionOverlayElement(element, rect)
    for (const { element, point, lift } of pointPlacements) positionPointElement(element, point, lift)
  })

  const hasPresenceWork = peers.some(
    (peer) =>
      peer.selectedNodeIds.length > 0 ||
      (peer.pointer !== null && peer.pointer.breakpointId === breakpointId),
  )

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
                {peer.user.name}
              </div>
            )}
            {peer.pointer !== null && peer.pointer.breakpointId === breakpointId && (
              <div
                ref={(el) => {
                  if (el) pointerRefs.current?.set(peer.clientId, el)
                  else pointerRefs.current?.delete(peer.clientId)
                }}
                className={styles.pointer}
                data-peer-pointer="true"
              >
                <span className={styles.pointerDot} />
                <span className={styles.pointerLabel}>{peer.user.name}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  return createPortal(chrome, portalCanvasRoot ?? document.body)
}
