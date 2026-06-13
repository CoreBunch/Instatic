import { getAncestors, type NodeTree, type PageNode } from '@core/page-tree'

type CanvasTreeLadderRelation = 'ancestor' | 'current' | 'firstChild'
type CanvasTreeLadderDirection = 'up' | 'down'
type CanvasTreeLadderPlacement = 'above' | 'below'

export interface CanvasTreeLadderRow {
  nodeId: string
  depth: number
  relation: CanvasTreeLadderRelation
}

interface CanvasTreeLadderSelectionController {
  activeBreakpointId: string | null
  setActiveBreakpoint: (breakpointId: string) => void
  selectNode: (nodeId: string) => void
}

interface CanvasTreeLadderRect {
  x: number
  y: number
  width: number
  height: number
}

interface CanvasTreeLadderBox {
  width: number
  height: number
}

interface CanvasTreeLadderBounds {
  width: number
  height: number
}

interface CanvasTreeLadderPosition {
  x: number
  y: number
  pointerX: number
  placement: CanvasTreeLadderPlacement
}

/**
 * Build the mini tree shown by Alt/Option canvas inspect.
 *
 * Rows intentionally follow editor tree structure, not DOM parentElement:
 * ancestors sit above the hovered node, and the first visible direct child
 * sits below it as an affordance for keyboard targeting into children.
 */
export function buildCanvasTreeLadderRows(
  tree: NodeTree<PageNode> | null,
  currentNodeId: string | null,
): CanvasTreeLadderRow[] {
  if (!tree || !currentNodeId) return []

  const current = tree.nodes[currentNodeId]
  if (!current) return []

  const ancestors = getAncestors(tree, currentNodeId)
  const rows: CanvasTreeLadderRow[] = ancestors.map((ancestor, depth) => ({
    nodeId: ancestor.id,
    depth,
    relation: 'ancestor',
  }))

  rows.push({
    nodeId: current.id,
    depth: ancestors.length,
    relation: 'current',
  })

  const firstVisibleChildId = current.children.find((childId) => {
    const child = tree.nodes[childId]
    return Boolean(child && !child.hidden)
  })
  if (firstVisibleChildId) {
    rows.push({
      nodeId: firstVisibleChildId,
      depth: ancestors.length + 1,
      relation: 'firstChild',
    })
  }

  return rows
}

export function moveCanvasTreeLadderHighlight(
  rows: readonly CanvasTreeLadderRow[],
  highlightedNodeId: string | null,
  direction: CanvasTreeLadderDirection,
): string | null {
  if (rows.length === 0) return null

  const currentIndex = rows.findIndex((row) => row.nodeId === highlightedNodeId)
  if (currentIndex < 0) {
    const currentRow = rows.find((row) => row.relation === 'current')
    return currentRow?.nodeId ?? rows[0].nodeId
  }

  const delta = direction === 'up' ? -1 : 1
  const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + delta))
  return rows[nextIndex].nodeId
}

export function commitCanvasTreeLadderSelection(
  controller: CanvasTreeLadderSelectionController,
  nodeId: string | null,
  breakpointId: string,
): boolean {
  if (!nodeId) return false
  if (controller.activeBreakpointId !== breakpointId) {
    controller.setActiveBreakpoint(breakpointId)
  }
  controller.selectNode(nodeId)
  return true
}

export function computeCanvasTreeLadderPosition(
  target: CanvasTreeLadderRect,
  ladder: CanvasTreeLadderBox,
  bounds: CanvasTreeLadderBounds,
): CanvasTreeLadderPosition {
  const margin = 10
  const gap = 10
  const pointerMargin = 16
  const maxX = Math.max(margin, bounds.width - ladder.width - margin)
  const maxY = Math.max(margin, bounds.height - ladder.height - margin)
  const targetCenterX = target.x + target.width / 2
  const x = clamp(targetCenterX - ladder.width / 2, margin, maxX)
  const aboveY = target.y - ladder.height - gap
  const belowY = target.y + target.height + gap
  const hasRoomAbove = aboveY >= margin
  const hasRoomBelow = belowY + ladder.height <= bounds.height - margin
  const placement: CanvasTreeLadderPlacement = hasRoomAbove || !hasRoomBelow ? 'above' : 'below'
  const y = clamp(placement === 'above' ? aboveY : belowY, margin, maxY)
  const pointerMax = Math.max(pointerMargin, ladder.width - pointerMargin)
  const pointerX = clamp(targetCenterX - x, pointerMargin, pointerMax)

  return {
    x: Math.round(x),
    y: Math.round(y),
    pointerX: Math.round(pointerX),
    placement,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
