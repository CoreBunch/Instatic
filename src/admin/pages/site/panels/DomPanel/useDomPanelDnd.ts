import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { DragCancelEvent, DragEndEvent, DragMoveEvent, DragStartEvent } from '@dnd-kit/core'
import type { Page } from '@core/page-tree'
import { registry } from '@core/module-engine'
import { getNodeDisplayName } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import {
  findDomDropRow,
  getDomDropZone,
  resolveDomDropTarget,
  type DomDropRowMeta,
  type DomDropTarget,
} from './domPanelDnd'
import type { DomPanelDndContextValue } from './DomPanelDndContext'
import { getDragPoint, getEventPoint } from '@admin/lib/dndPointer'

interface Point {
  x: number
  y: number
}

interface UseDomPanelDndOptions {
  page: Page | null
  treeAreaRef: RefObject<HTMLElement | null>
  isExpanded: (nodeId: string) => boolean
  expandNode: (nodeId: string) => void
}

interface DragPreview {
  label: string
  moduleId: string
  /** Number of nodes being dragged (1 for single-drag, >1 for multi). */
  count: number
}

const AUTO_EXPAND_DELAY_MS = 350
const STILL_MOVEMENT_TOLERANCE_PX = 4
const AUTO_SCROLL_EDGE_PX = 32
const AUTO_SCROLL_MAX_SPEED = 14

export function useDomPanelDnd({
  page,
  treeAreaRef,
  isExpanded,
  expandNode,
}: UseDomPanelDndOptions) {
  const rowsRef = useRef<Map<string, HTMLElement>>(new Map())
  const measuredRowsRef = useRef<DomDropRowMeta[]>([])
  const startPointRef = useRef<Point | null>(null)
  const latestPointerRef = useRef<Point | null>(null)
  const latestTargetRef = useRef<DomDropTarget | null>(null)
  const activeIdRef = useRef<string | null>(null)
  // Full multi-drag set (frozen at drag start). Defaults to `[activeId]` for
  // single-drag — when the user grabs a row that's part of an existing
  // multi-selection, the WHOLE selection is dragged.
  const activeIdsRef = useRef<string[]>([])
  const autoExpandRef = useRef<{
    targetKey: string
    point: Point
    timeoutId: number
  } | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const runAutoScrollRef = useRef<() => void>(() => {})

  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [target, setTarget] = useState<DomDropTarget | null>(null)
  const [invalidOverId, setInvalidOverId] = useState<string | null>(null)

  // exception #1: feeds resolveTargetAtPoint's effect-bound closure (exhaustive-deps)
  const canHaveChildren = useCallback((moduleId: string) => {
    return registry.get(moduleId)?.canHaveChildren === true
  }, [])

  const registerRow = (nodeId: string, element: HTMLElement | null) => {
    if (element) rowsRef.current.set(nodeId, element)
    else rowsRef.current.delete(nodeId)
  }

  // exception #1: feeds runAutoScroll's effect-bound closure (exhaustive-deps)
  const measureRows = useCallback(() => {
    measuredRowsRef.current = Array.from(rowsRef.current.entries())
      .map(([nodeId, element]) => {
        const rect = element.getBoundingClientRect()
        return {
          nodeId,
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
          },
        }
      })
      .sort((a, b) => a.rect.top - b.rect.top)
  }, [])

  // exception #1: feeds runAutoScroll/resetDragState effect-bound closures (exhaustive-deps)
  const clearAutoExpand = useCallback(() => {
    const pending = autoExpandRef.current
    if (pending) window.clearTimeout(pending.timeoutId)
    autoExpandRef.current = null
  }, [])

  // exception #1: feeds runAutoScroll/resetDragState effect-bound closures (exhaustive-deps)
  const setResolvedTarget = useCallback((next: DomDropTarget | null) => {
    latestTargetRef.current = next
    setTarget((prev) => areTargetsEqual(prev, next) ? prev : next)
  }, [])

  // exception #1: feeds runAutoScroll's effect-bound closure (exhaustive-deps)
  const scheduleAutoExpand = useCallback((next: DomDropTarget | null, point: Point) => {
    if (!next || next.position !== 'inside' || isExpanded(next.parentId)) {
      clearAutoExpand()
      return
    }

    const targetKey = getTargetKey(next)
    const pending = autoExpandRef.current
    if (
      pending &&
      pending.targetKey === targetKey &&
      distance(pending.point, point) <= STILL_MOVEMENT_TOLERANCE_PX
    ) {
      return
    }

    clearAutoExpand()
    const timeoutId = window.setTimeout(() => {
      expandNode(next.parentId)
      autoExpandRef.current = null
      requestAnimationFrame(measureRows)
    }, AUTO_EXPAND_DELAY_MS)

    autoExpandRef.current = { targetKey, point, timeoutId }
  }, [clearAutoExpand, expandNode, isExpanded, measureRows])

  // exception #1: feeds runAutoScroll's effect-bound closure (exhaustive-deps)
  const resolveTargetAtPoint = useCallback((draggedId: string, point: Point) => {
    if (!page) {
      setResolvedTarget(null)
      setInvalidOverId(null)
      clearAutoExpand()
      return
    }

    const row = findDomDropRow(measuredRowsRef.current, point.y)
    if (!row) {
      setResolvedTarget(null)
      setInvalidOverId(null)
      clearAutoExpand()
      return
    }

    const zone = getDomDropZone(row.rect, point.y)
    // Multi-drag: pass the full drag set so cycle / no-self-drop checks
    // consider every dragged id, not just the pivot.
    const draggedIds = activeIdsRef.current.length > 0
      ? activeIdsRef.current
      : [draggedId]
    const next = resolveDomDropTarget({
      page,
      draggedId,
      draggedIds,
      overId: row.nodeId,
      zone,
      canHaveChildren,
    })

    setResolvedTarget(next)
    setInvalidOverId(next ? null : row.nodeId)
    scheduleAutoExpand(next, point)
  }, [canHaveChildren, clearAutoExpand, page, scheduleAutoExpand, setResolvedTarget])

  // exception #1: feeds resetDragState's effect-bound closure (exhaustive-deps)
  const stopAutoScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  // exception #1: assigned to runAutoScrollRef inside a useEffect dep array (exhaustive-deps)
  const runAutoScroll = useCallback(() => {
    scrollFrameRef.current = null
    const container = treeAreaRef.current
    const point = latestPointerRef.current
    const draggedId = activeIdRef.current

    if (!container || !point || !draggedId) return

    const rect = container.getBoundingClientRect()
    const topDistance = point.y - rect.top
    const bottomDistance = rect.bottom - point.y
    let speed = 0

    if (topDistance >= 0 && topDistance < AUTO_SCROLL_EDGE_PX) {
      speed = -scrollSpeed(topDistance)
    } else if (bottomDistance >= 0 && bottomDistance < AUTO_SCROLL_EDGE_PX) {
      speed = scrollSpeed(bottomDistance)
    }

    if (speed === 0) return

    // scrollBy (method call) instead of `container.scrollTop += speed`
    // (property assignment). React Compiler flags property assignment on
    // values reached through a hook-argument ref; method calls are treated
    // as opaque DOM API calls, which is what we want here.
    container.scrollBy({ top: speed })
    measureRows()
    resolveTargetAtPoint(draggedId, point)
    scrollFrameRef.current = requestAnimationFrame(() => runAutoScrollRef.current())
  }, [measureRows, resolveTargetAtPoint, treeAreaRef])

  useEffect(() => {
    runAutoScrollRef.current = runAutoScroll
  }, [runAutoScroll])

  const updateAutoScroll = (point: Point) => {
    latestPointerRef.current = point
    if (scrollFrameRef.current === null) {
      scrollFrameRef.current = requestAnimationFrame(() => runAutoScrollRef.current())
    }
  }

  // exception #1: referenced in a useEffect dep array (cleanup on unmount, exhaustive-deps)
  const resetDragState = useCallback(() => {
    stopAutoScroll()
    clearAutoExpand()
    activeIdRef.current = null
    activeIdsRef.current = []
    startPointRef.current = null
    latestPointerRef.current = null
    latestTargetRef.current = null
    setActiveId(null)
    setDragPreview(null)
    setResolvedTarget(null)
    setInvalidOverId(null)
  }, [clearAutoExpand, setResolvedTarget, stopAutoScroll])

  const handleDragStart = (event: DragStartEvent) => {
    const draggedId = String(event.active.id)
    const node = page?.nodes[draggedId]
    if (!node) return

    // Multi-drag set: if the grabbed row is part of an existing multi-selection,
    // the WHOLE selection is dragged; otherwise just this row. The selection set
    // is captured at drag start and frozen for the rest of the gesture.
    const selectedIds = useEditorStore.getState().selectedNodeIds
    const draggedIds = selectedIds.includes(draggedId) && selectedIds.length > 1
      ? [...selectedIds]
      : [draggedId]

    activeIdRef.current = draggedId
    activeIdsRef.current = draggedIds
    measureRows()

    const point = getEventPoint(event.activatorEvent) ?? getRowCenter(rowsRef.current.get(draggedId))
    startPointRef.current = point
    latestPointerRef.current = point
    setActiveId(draggedId)

    const def = registry.get(node.moduleId)
    const visualComponents = useEditorStore.getState().site?.visualComponents
    setDragPreview({
      label: getNodeDisplayName(node, def, visualComponents),
      moduleId: node.moduleId,
      count: draggedIds.length,
    })
  }

  const handleDragMove = (event: DragMoveEvent) => {
    const draggedId = String(event.active.id)
    const point = getDragPoint(event, startPointRef.current)
    if (!point) return

    latestPointerRef.current = point
    resolveTargetAtPoint(draggedId, point)
    updateAutoScroll(point)
  }

  const handleDragEnd = (_event: DragEndEvent): DomDropTarget | null => {
    const finalTarget = latestTargetRef.current
    resetDragState()
    return finalTarget
  }

  const handleDragCancel = (_event: DragCancelEvent) => {
    resetDragState()
  }

  useEffect(() => resetDragState, [resetDragState])

  const contextValue: DomPanelDndContextValue = {
    activeId,
    target,
    invalidOverId,
    registerRow,
  }

  return {
    contextValue,
    activeId,
    activeLabel: dragPreview?.label ?? null,
    activeModuleId: dragPreview?.moduleId ?? null,
    /** 1 for a single-row drag, >1 when a multi-selection is being dragged. */
    activeCount: dragPreview?.count ?? 0,
    target,
    invalidOverId,
    registerRow,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  }
}

function getRowCenter(element: HTMLElement | undefined): Point | null {
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  }
}

function areTargetsEqual(a: DomDropTarget | null, b: DomDropTarget | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.draggedId === b.draggedId &&
    a.parentId === b.parentId &&
    a.index === b.index &&
    a.position === b.position &&
    a.overId === b.overId &&
    a.slot === b.slot
  )
}

function getTargetKey(target: DomDropTarget): string {
  return `${target.draggedId}:${target.parentId}:${target.index}:${target.position}:${target.overId}`
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function scrollSpeed(distanceFromEdge: number): number {
  const ratio = 1 - Math.max(0, Math.min(AUTO_SCROLL_EDGE_PX, distanceFromEdge)) / AUTO_SCROLL_EDGE_PX
  return Math.max(1, Math.ceil(ratio * AUTO_SCROLL_MAX_SPEED))
}
