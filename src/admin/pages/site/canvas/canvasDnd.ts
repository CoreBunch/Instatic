import type { PageNode } from '@core/page-tree'
import type { NodeTree } from '@core/page-tree'
import {
  getParent,
  resolvePageTreeDropTarget,
  type PageTreeDropPosition,
  type PageTreeDropTarget,
} from '@core/page-tree'

interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type CanvasDropAxis = 'vertical' | 'horizontal'

export interface CanvasDropCandidate {
  nodeId: string
  depth: number
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasDropTarget extends PageTreeDropTarget {
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasInsertionTarget {
  parentId: string
  index: number
  position: PageTreeDropPosition
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
}

interface CanvasInvalidDropTarget {
  overId: string
  rect: CanvasRect
  axis: CanvasDropAxis
}

export interface CanvasDropResolution {
  target: CanvasDropTarget | null
  invalid: CanvasInvalidDropTarget | null
}

interface ResolveCanvasDropTargetInput {
  tree: NodeTree<PageNode>
  draggedId: string
  draggedIds: string[]
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (moduleId: string) => boolean
}

interface ResolveCanvasInsertionTargetInput {
  tree: NodeTree<PageNode>
  candidates: CanvasDropCandidate[]
  point: CanvasPoint
  canHaveChildren: (moduleId: string) => boolean
}

const MIN_EDGE_HIT_ZONE = 8
const MAX_EDGE_HIT_ZONE = 20
const EDGE_ZONE_RATIO = 0.26

export function getCanvasDropZone(
  candidate: CanvasDropCandidate,
  point: CanvasPoint,
): PageTreeDropPosition {
  const { rect, axis } = candidate
  const size = axis === 'horizontal' ? rect.width : rect.height
  const edgeBand = Math.max(
    MIN_EDGE_HIT_ZONE,
    Math.min(MAX_EDGE_HIT_ZONE, size * EDGE_ZONE_RATIO),
  )

  if (axis === 'horizontal') {
    const offset = point.x - rect.left
    if (offset <= edgeBand) return 'before'
    if (offset >= rect.width - edgeBand) return 'after'
    return 'inside'
  }

  const offset = point.y - rect.top
  if (offset <= edgeBand) return 'before'
  if (offset >= rect.height - edgeBand) return 'after'
  return 'inside'
}

export function resolveCanvasDropTarget({
  tree,
  draggedId,
  draggedIds,
  candidates,
  point,
  canHaveChildren,
}: ResolveCanvasDropTargetInput): CanvasDropResolution {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return { target: null, invalid: null }

  const zone = getCanvasDropZone(candidate, point)
  const target = resolvePageTreeDropTarget({
    tree,
    draggedId,
    draggedIds,
    overId: candidate.nodeId,
    zone,
    canHaveChildren,
  })

  if (!target) {
    return {
      target: null,
      invalid: {
        overId: candidate.nodeId,
        rect: candidate.rect,
        axis: candidate.axis,
      },
    }
  }

  return {
    target: {
      ...target,
      rect: candidate.rect,
      axis: candidate.axis,
    },
    invalid: null,
  }
}

export function resolveCanvasInsertionTarget({
  tree,
  candidates,
  point,
  canHaveChildren,
}: ResolveCanvasInsertionTargetInput): CanvasInsertionTarget | null {
  const candidate = findCanvasDropCandidate(candidates, point)
  if (!candidate) return null

  const zone = getCanvasDropZone(candidate, point)
  const target = resolvePageTreeInsertionTarget({
    tree,
    overId: candidate.nodeId,
    zone,
    canHaveChildren,
  })
  if (!target) return null

  return {
    ...target,
    rect: candidate.rect,
    axis: candidate.axis,
  }
}

interface ResolvePageTreeInsertionTargetInput {
  tree: NodeTree<PageNode>
  overId: string
  zone: PageTreeDropPosition
  canHaveChildren: (moduleId: string) => boolean
}

function resolvePageTreeInsertionTarget({
  tree,
  overId,
  zone,
  canHaveChildren,
}: ResolvePageTreeInsertionTargetInput): Omit<CanvasInsertionTarget, 'rect' | 'axis'> | null {
  const over = tree.nodes[overId]
  if (!over) return null

  if (overId === tree.rootNodeId) {
    const index = zone === 'before' ? 0 : tree.nodes[tree.rootNodeId]?.children.length ?? 0
    return {
      parentId: tree.rootNodeId,
      index,
      position: zone === 'before' ? 'before' : 'inside',
      overId,
    }
  }

  if (
    zone === 'inside' &&
    canHaveChildren(over.moduleId) &&
    (!over.locked || over.moduleId === 'base.slot-instance')
  ) {
    if (over.moduleId === 'base.visual-component-ref') {
      const slotInstanceChildId = over.children.find(
        (childId) => tree.nodes[childId]?.moduleId === 'base.slot-instance',
      )
      if (slotInstanceChildId) {
        const slot = tree.nodes[slotInstanceChildId]
        return {
          parentId: slotInstanceChildId,
          index: slot?.children.length ?? 0,
          position: 'inside',
          overId,
        }
      }
      return siblingInsertionTarget(tree, overId, 'after')
    }

    return {
      parentId: overId,
      index: over.children.length,
      position: 'inside',
      overId,
    }
  }

  return siblingInsertionTarget(tree, overId, zone === 'before' ? 'before' : 'after')
}

function siblingInsertionTarget(
  tree: NodeTree<PageNode>,
  overId: string,
  position: 'before' | 'after',
): Omit<CanvasInsertionTarget, 'rect' | 'axis'> | null {
  if (overId === tree.rootNodeId) return null
  const parent = getParent(tree, overId)
  if (!parent || parent.locked || parent.moduleId === 'base.visual-component-ref') {
    return null
  }

  const overIndex = parent.children.indexOf(overId)
  if (overIndex === -1) return null

  return {
    parentId: parent.id,
    index: position === 'before' ? overIndex : overIndex + 1,
    position,
    overId,
  }
}

function findCanvasDropCandidate(
  candidates: CanvasDropCandidate[],
  point: CanvasPoint,
): CanvasDropCandidate | null {
  const containing = candidates.filter((candidate) => containsPoint(candidate.rect, point))
  if (containing.length === 0) return null

  return containing.sort((a, b) => {
    const depthDiff = b.depth - a.depth
    if (depthDiff !== 0) return depthDiff
    return area(a.rect) - area(b.rect)
  })[0] ?? null
}

function containsPoint(rect: CanvasRect, point: CanvasPoint): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  )
}

function area(rect: CanvasRect): number {
  return rect.width * rect.height
}
