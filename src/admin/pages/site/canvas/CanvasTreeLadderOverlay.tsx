import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { StyleRuleRegistry } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { selectActiveCanvasPage, useEditorStore } from '@site/store/store'
import { CanvasTreeLadderRowButton } from './CanvasTreeLadderRowButton'
import {
  buildCanvasTreeLadderRows,
  commitCanvasTreeLadderSelection,
  computeCanvasTreeLadderPosition,
  moveCanvasTreeLadderHighlight,
  type CanvasTreeLadderRow,
} from './canvasTreeLadder'
import { escapeCssAttributeValue } from './canvasNodeLookup'
import { measureCanvasElementRect } from './canvasOverlayGeometry'
import styles from './BreakpointSelectionOverlay.module.css'

const EMPTY_STYLE_RULES: StyleRuleRegistry = {}
const EMPTY_VISUAL_COMPONENTS: readonly VisualComponent[] = []

type CanvasOverlayPortalMode = 'scoped' | 'fixed'

interface UseCanvasTreeLadderOverlayArgs {
  breakpointId: string
  iframeElement: HTMLIFrameElement | null
  canvasRoot: HTMLElement | null
  portalTarget: HTMLElement
  portalMode: CanvasOverlayPortalMode
  show: boolean
  hoveredNodeId: string | null
  hoveredBreakpointOrigin: string | null
}

interface CanvasTreeLadderOverlayResult {
  hoverNodeId: string | null
  portal: ReactNode
}

export function useCanvasTreeLadderOverlay({
  breakpointId,
  iframeElement,
  canvasRoot,
  portalTarget,
  portalMode,
  show,
  hoveredNodeId,
  hoveredBreakpointOrigin,
}: UseCanvasTreeLadderOverlayArgs): CanvasTreeLadderOverlayResult {
  const activePage = useEditorStore(selectActiveCanvasPage)
  const styleRules = useEditorStore((s) => s.site?.styleRules ?? EMPTY_STYLE_RULES)
  const visualComponents = useEditorStore((s) => s.site?.visualComponents ?? EMPTY_VISUAL_COMPONENTS)
  const treeLadderRef = useRef<HTMLDivElement>(null)
  const [inspectActive, setInspectActive] = useState(false)
  const [inspectSuppressed, setInspectSuppressed] = useState(false)
  const [inspectAnchorNodeId, setInspectAnchorNodeId] = useState<string | null>(null)
  const [treeLadderHighlightedNodeId, setTreeLadderHighlightedNodeId] = useState<string | null>(null)

  const treeLadderRows = buildCanvasTreeLadderRows(activePage, inspectAnchorNodeId)
  const treeLadderKey = treeLadderRows.map((row) => `${row.nodeId}:${row.depth}:${row.relation}`).join('|')
  const showTreeLadder =
    show &&
    inspectActive &&
    !inspectSuppressed &&
    Boolean(inspectAnchorNodeId) &&
    treeLadderRows.length > 0
  // The row the user has *explicitly* landed on (mouse-hover or arrow keys),
  // distinct from the "current"-relation fallback below. Non-null only when a
  // real highlight is active and still maps to a visible row — releasing Alt
  // commits exactly this, so it must never fall back to a default.
  const explicitHighlightNodeId =
    showTreeLadder && treeLadderRows.some((row) => row.nodeId === treeLadderHighlightedNodeId)
      ? treeLadderHighlightedNodeId
      : null
  const effectiveTreeLadderHighlightedNodeId =
    explicitHighlightNodeId ??
    (showTreeLadder
      ? treeLadderRows.find((row) => row.relation === 'current')?.nodeId ?? treeLadderRows[0]?.nodeId ?? null
      : null)
  const hoverNodeId = showTreeLadder
    ? effectiveTreeLadderHighlightedNodeId ?? inspectAnchorNodeId
    : null

  // React Compiler exception #1: this function is referenced by the keyboard
  // listener effect, so exhaustive-deps requires a stable identity.
  const commitTreeLadderSelection = useCallback((nodeId: string | null) => {
    const state = useEditorStore.getState()
    if (!commitCanvasTreeLadderSelection(state, nodeId, breakpointId)) return
    setInspectSuppressed(true)
    setInspectActive(false)
    setInspectAnchorNodeId(null)
    setTreeLadderHighlightedNodeId(null)
  }, [breakpointId])

  useEffect(() => useEditorStore.subscribe(
    (s) => [s.hoveredNodeId, s.hoveredBreakpointId] as const,
    ([nodeId, hoveredBreakpoint]) => {
      if (!inspectActive || inspectSuppressed) return
      if (nodeId && hoveredBreakpoint === breakpointId) {
        setInspectAnchorNodeId(nodeId)
        setTreeLadderHighlightedNodeId(null)
      }
    },
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
  ), [breakpointId, inspectActive, inspectSuppressed])

  useEffect(() => {
    if (!iframeElement) return

    const handleMouseMove = (event: MouseEvent) => {
      if (!event.altKey || isEditableKeyboardTarget(event.target)) return
      if (!isElementLike(event.target)) return

      const nodeElement = event.target.closest('[data-node-id]')
      const rawNodeId = nodeElement?.getAttribute('data-node-id') ?? null
      if (!rawNodeId) return

      const state = useEditorStore.getState()
      const activeTree = selectActiveCanvasPage(state)
      const hoveredId =
        state.hoveredBreakpointId === breakpointId && state.hoveredNodeId
          ? state.hoveredNodeId
          : null
      const anchorNodeId = hoveredId && activeTree?.nodes[hoveredId] ? hoveredId : rawNodeId

      setInspectActive(true)
      setInspectSuppressed(false)
      setInspectAnchorNodeId(anchorNodeId)
      setTreeLadderHighlightedNodeId(null)
    }

    let iframeDoc: Document | null = null
    let frame = 0

    const attach = () => {
      if (iframeDoc) return
      const nextDoc = iframeElement?.contentDocument ?? null
      if (!nextDoc) {
        frame = requestAnimationFrame(attach)
        return
      }
      iframeDoc = nextDoc
      iframeDoc.addEventListener('mousemove', handleMouseMove)
    }

    attach()
    iframeElement.addEventListener('load', attach)

    return () => {
      cancelAnimationFrame(frame)
      iframeElement.removeEventListener('load', attach)
      iframeDoc?.removeEventListener('mousemove', handleMouseMove)
    }
  }, [breakpointId, iframeElement])

  useEffect(() => {
    const clearInspect = () => {
      setInspectActive(false)
      setInspectSuppressed(false)
      setInspectAnchorNodeId(null)
      setTreeLadderHighlightedNodeId(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) return

      if (event.key === 'Alt') {
        setInspectActive(true)
        setInspectSuppressed(false)
        if (hoveredNodeId && hoveredBreakpointOrigin === breakpointId) {
          setInspectAnchorNodeId(hoveredNodeId)
          setTreeLadderHighlightedNodeId(null)
        }
        return
      }

      if (!showTreeLadder) return

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        event.stopPropagation()
        const direction = event.key === 'ArrowUp' ? 'up' : 'down'
        setTreeLadderHighlightedNodeId(
          moveCanvasTreeLadderHighlight(treeLadderRows, effectiveTreeLadderHighlightedNodeId, direction),
        )
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        commitTreeLadderSelection(effectiveTreeLadderHighlightedNodeId ?? inspectAnchorNodeId)
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        clearInspect()
      }
    }

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== 'Alt') return
      // Releasing Alt commits the row the user explicitly moved onto (mouse or
      // arrow keys) and keeps it selected. Just holding Alt over an element
      // without landing on a row tears the ladder down without selecting.
      if (showTreeLadder && explicitHighlightNodeId) {
        commitTreeLadderSelection(explicitHighlightNodeId)
        return
      }
      clearInspect()
    }

    const cleanups: Array<() => void> = []
    const attachDocument = (doc: Document) => {
      doc.addEventListener('keydown', handleKeyDown)
      doc.addEventListener('keyup', handleKeyUp)
      doc.defaultView?.addEventListener('blur', clearInspect)
      const cleanup = () => {
        doc.removeEventListener('keydown', handleKeyDown)
        doc.removeEventListener('keyup', handleKeyUp)
        doc.defaultView?.removeEventListener('blur', clearInspect)
      }
      cleanups.push(cleanup)
    }

    let iframeDoc: Document | null = null
    let frame = 0
    const attachIframeDocument = () => {
      if (iframeDoc) return
      const nextDoc = iframeElement?.contentDocument ?? null
      if (!nextDoc) {
        frame = requestAnimationFrame(attachIframeDocument)
        return
      }
      iframeDoc = nextDoc
      attachDocument(iframeDoc)
    }

    attachDocument(document)
    if (iframeElement) {
      attachIframeDocument()
      iframeElement.addEventListener('load', attachIframeDocument)
    }

    return () => {
      cancelAnimationFrame(frame)
      iframeElement?.removeEventListener('load', attachIframeDocument)
      for (const cleanup of cleanups) cleanup()
    }
  }, [
    iframeElement,
    commitTreeLadderSelection,
    effectiveTreeLadderHighlightedNodeId,
    explicitHighlightNodeId,
    hoveredBreakpointOrigin,
    hoveredNodeId,
    inspectAnchorNodeId,
    breakpointId,
    showTreeLadder,
    treeLadderRows,
    treeLadderKey,
  ])

  const tickOnce = useEffectEvent((iframe: HTMLIFrameElement | null, root: HTMLElement | null) => {
    positionTreeLadder(
      treeLadderRef.current,
      showTreeLadder ? inspectAnchorNodeId : null,
      treeLadderRows,
      iframe,
      root,
    )
  })

  useEffect(() => {
    if (!showTreeLadder) return

    let frame = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) return
      tickOnce(iframeElement, canvasRoot)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [canvasRoot, iframeElement, showTreeLadder, treeLadderKey])

  const portal = showTreeLadder ? createPortal(
    <div
      ref={treeLadderRef}
      role="group"
      aria-label="Select canvas element from tree"
      className={styles.treeLadder}
      data-canvas-tree-ladder="true"
      data-canvas-tree-ladder-mode={portalMode}
      data-placement="above"
    >
      <div className={styles.treeLadderRows}>
        {treeLadderRows.map((row) => {
          const node = activePage?.nodes[row.nodeId] ?? null
          if (!node) return null
          return (
            <CanvasTreeLadderRowButton
              key={`${row.nodeId}:${row.relation}`}
              row={row}
              node={node}
              highlighted={row.nodeId === effectiveTreeLadderHighlightedNodeId}
              styleRules={styleRules}
              visualComponents={visualComponents}
              onHighlight={setTreeLadderHighlightedNodeId}
              onCommit={commitTreeLadderSelection}
            />
          )
        })}
      </div>
    </div>,
    portalTarget,
  ) : null

  return { hoverNodeId, portal }
}

function positionTreeLadder(
  ladder: HTMLDivElement | null,
  nodeId: string | null,
  rows: readonly CanvasTreeLadderRow[],
  iframe: HTMLIFrameElement | null,
  canvasRoot: HTMLElement | null,
): void {
  if (!ladder || !nodeId || !iframe || rows.length === 0) {
    if (ladder) ladder.style.display = 'none'
    return
  }

  const iframeDoc = iframe.contentDocument
  if (!iframeDoc) {
    ladder.style.display = 'none'
    return
  }

  const target = iframeDoc.querySelector<HTMLElement>(
    `[data-node-id="${escapeCssAttributeValue(nodeId)}"]`,
  )
  const rect = measureCanvasElementRect(target, iframe, canvasRoot)
  if (!rect) {
    ladder.style.display = 'none'
    return
  }

  ladder.style.display = ''
  const ladderRect = ladder.getBoundingClientRect()
  const view = ladder.ownerDocument.defaultView
  const boundsWidth = canvasRoot?.clientWidth || view?.innerWidth || ladderRect.width
  const boundsHeight = canvasRoot?.clientHeight || view?.innerHeight || ladderRect.height
  const position = computeCanvasTreeLadderPosition(
    rect,
    {
      width: ladderRect.width || ladder.offsetWidth,
      height: ladderRect.height || ladder.offsetHeight,
    },
    { width: boundsWidth, height: boundsHeight },
  )
  ladder.dataset.placement = position.placement
  ladder.style.setProperty('--canvas-ladder-x', `${position.x}px`)
  ladder.style.setProperty('--canvas-ladder-y', `${position.y}px`)
  ladder.style.setProperty('--canvas-ladder-pointer-x', `${position.pointerX}px`)
}

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!isElementLike(target)) return false
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true
  }
  return target.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]') !== null
}

function isElementLike(value: EventTarget | null): value is Element {
  return value != null && typeof (value as { closest?: unknown }).closest === 'function'
}
