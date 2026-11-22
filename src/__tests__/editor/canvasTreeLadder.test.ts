import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { NodeTree, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import {
  buildCanvasTreeLadderRows,
  commitCanvasTreeLadderSelection,
  computeCanvasTreeLadderPosition,
  moveCanvasTreeLadderHighlight,
} from '@site/canvas/canvasTreeLadder'

function node(
  id: string,
  moduleId: string,
  children: string[] = [],
  options: Partial<PageNode> = {},
): PageNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children,
    classIds: [],
    ...options,
  }
}

const tree: NodeTree<PageNode> = {
  rootNodeId: 'root',
  nodes: {
    root: node('root', 'base.body', ['checkout']),
    checkout: node('checkout', 'base.forms.form', ['account']),
    account: node('account', 'base.container', ['title', 'email']),
    title: node('title', 'base.text', ['hiddenAccent', 'accent']),
    hiddenAccent: node('hiddenAccent', 'base.text', [], { hidden: true }),
    accent: node('accent', 'base.text'),
    email: node('email', 'base.forms.input'),
  },
}
reindexNodeParents(tree.nodes)

const ladderCss = readFileSync(
  new URL('../../admin/pages/site/canvas/BreakpointSelectionOverlay.module.css', import.meta.url),
  'utf8',
)
const ladderRowButtonSource = readFileSync(
  new URL('../../admin/pages/site/canvas/CanvasTreeLadderRowButton.tsx', import.meta.url),
  'utf8',
)

describe('canvas tree ladder model', () => {
  it('builds ancestors above the current node and the first visible child below it', () => {
    const rows = buildCanvasTreeLadderRows(tree, 'title')

    expect(rows).toEqual([
      { nodeId: 'root', depth: 0, relation: 'ancestor' },
      { nodeId: 'checkout', depth: 1, relation: 'ancestor' },
      { nodeId: 'account', depth: 2, relation: 'ancestor' },
      { nodeId: 'title', depth: 3, relation: 'current' },
      { nodeId: 'accent', depth: 4, relation: 'firstChild' },
    ])
  })

  it('returns no rows when the current node is missing from the tree', () => {
    expect(buildCanvasTreeLadderRows(tree, 'missing')).toEqual([])
  })

  it('moves keyboard highlight up to parents and down toward the child without leaving the row set', () => {
    const rows = buildCanvasTreeLadderRows(tree, 'title')

    expect(moveCanvasTreeLadderHighlight(rows, 'title', 'up')).toBe('account')
    expect(moveCanvasTreeLadderHighlight(rows, 'account', 'down')).toBe('title')
    expect(moveCanvasTreeLadderHighlight(rows, 'title', 'down')).toBe('accent')
    expect(moveCanvasTreeLadderHighlight(rows, 'root', 'up')).toBe('root')
    expect(moveCanvasTreeLadderHighlight(rows, 'accent', 'down')).toBe('accent')
  })

  it('commits a ladder selection without stealing focus from the properties panel', () => {
    const calls: string[] = []
    const controller = {
      activeBreakpointId: 'desktop',
      selectNode: (nodeId: string) => calls.push(`select:${nodeId}`),
      setActiveBreakpoint: (breakpointId: string) => calls.push(`breakpoint:${breakpointId}`),
      setFocusedPanel: (panel: string) => calls.push(`focus:${panel}`),
    }

    const committed = commitCanvasTreeLadderSelection(controller, 'payment', 'mobile')

    expect(committed).toBe(true)
    expect(calls).toEqual(['breakpoint:mobile', 'select:payment'])
  })

  it('does not commit an empty ladder selection', () => {
    const calls: string[] = []

    const committed = commitCanvasTreeLadderSelection(
      {
        activeBreakpointId: 'desktop',
        selectNode: (nodeId: string) => calls.push(`select:${nodeId}`),
        setActiveBreakpoint: (breakpointId: string) => calls.push(`breakpoint:${breakpointId}`),
      },
      null,
      'desktop',
    )

    expect(committed).toBe(false)
    expect(calls).toEqual([])
  })

  it('positions the ladder above the target when there is room', () => {
    const position = computeCanvasTreeLadderPosition(
      { x: 100, y: 120, width: 80, height: 30 },
      { width: 240, height: 90 },
      { width: 500, height: 400 },
    )

    expect(position).toEqual({
      x: 20,
      y: 20,
      pointerX: 120,
      placement: 'above',
    })
  })

  it('falls below and clamps to the canvas edge when the ladder would overflow', () => {
    const position = computeCanvasTreeLadderPosition(
      { x: 8, y: 12, width: 50, height: 20 },
      { width: 220, height: 80 },
      { width: 260, height: 180 },
    )

    expect(position).toEqual({
      x: 10,
      y: 42,
      pointerX: 23,
      placement: 'below',
    })
  })

  it('keeps the ladder chrome quiet without a bubble border or row rail', () => {
    expect(cssRule(ladderCss, '.treeLadder')).not.toMatch(/(?:^|\n)\s*border\s*:/)
    expect(cssRule(ladderCss, '.treeLadderRow.treeLadderRow')).not.toContain('border-left')
  })

  it('keeps a pointer bridge between the anchored ladder and target', () => {
    const bridgeRule = cssRule(ladderCss, '.treeLadder::before')

    expect(bridgeRule).toContain('height: 32px')
    expect(bridgeRule).toContain('pointer-events: auto')
  })

  it('keeps ladder rows compact and single-line', () => {
    expect(ladderRowButtonSource).not.toContain('treeLadderModule')
    expect(cssRule(ladderCss, '.treeLadderRow.treeLadderRow')).toContain('min-height: 24px')
    expect(cssRule(ladderCss, '.treeLadderMain')).toContain('display: inline-flex')
  })

  it('aligns ladder radii and keeps relation text in normal case', () => {
    expect(cssRule(ladderCss, '.treeLadder')).toContain('padding: var(--space-3xs)')
    expect(cssRule(ladderCss, '.treeLadder')).toContain('border-radius: var(--panel-radius)')
    expect(cssRule(ladderCss, '.treeLadderRow.treeLadderRow')).toContain(
      'border-radius: calc(var(--panel-radius) - var(--space-3xs))',
    )
    expect(cssRule(ladderCss, '.treeLadderRelation')).not.toContain('text-transform')
  })

  it('renders the pointer as an external triangle below row backgrounds', () => {
    const pointerRule = cssRule(ladderCss, '.treeLadder::after')
    const abovePointerRule = cssRule(ladderCss, '.treeLadder[data-placement="above"]::after')
    const belowPointerRule = cssRule(ladderCss, '.treeLadder[data-placement="below"]::after')

    expect(pointerRule).toContain('width: 12px')
    expect(pointerRule).toContain('height: 8px')
    expect(pointerRule).toContain('z-index: 0')
    expect(abovePointerRule).toContain('bottom: -8px')
    expect(abovePointerRule).toContain('clip-path: polygon(50% 100%, 0 0, 100% 0)')
    expect(abovePointerRule).not.toContain('rotate')
    expect(belowPointerRule).toContain('top: -8px')
    expect(belowPointerRule).toContain('clip-path: polygon(50% 0, 0 100%, 100% 100%)')
    expect(belowPointerRule).not.toContain('rotate')
    expect(cssRule(ladderCss, '.treeLadderRows')).toContain('position: relative')
    expect(cssRule(ladderCss, '.treeLadderRows')).toContain('z-index: 1')
  })
})

function cssRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}
