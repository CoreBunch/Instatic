import { describe, it, expect } from 'bun:test'
import { getCanvasNodeClassIds, getCanvasNodeClassName } from '@site/canvas/canvasNodeClassName'
import { classKindSelector, type StyleRule } from '@core/page-tree'

function makeClass(id: string, name: string): StyleRule {
  return {
    id,
    name,
    kind: 'class',
    selector: classKindSelector(name),
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

const classes = {
  assigned: makeClass('assigned', 'assigned_name'),
  preview: makeClass('preview', 'preview_name'),
}

describe('NodeRenderer class hover preview', () => {
  it('adds a hovered class preview to the matching canvas node className', () => {
    expect(
      getCanvasNodeClassName(
        ['assigned'],
        { nodeId: 'node-1', classId: 'preview' },
        'node-1',
        classes,
      ),
    ).toBe('assigned_name preview_name')
  })

  it('does not add a preview class to other nodes', () => {
    expect(
      getCanvasNodeClassName(
        ['assigned'],
        { nodeId: 'node-2', classId: 'preview' },
        'node-1',
        classes,
      ),
    ).toBe('assigned_name')
  })

  it('does not duplicate a class already assigned to the node', () => {
    expect(
      getCanvasNodeClassName(
        ['assigned', 'preview'],
        { nodeId: 'node-1', classId: 'preview' },
        'node-1',
        classes,
      ),
    ).toBe('assigned_name preview_name')
  })
})

describe('getCanvasNodeClassIds referential stability', () => {
  // These run in a per-node Zustand selector on every store set — when no
  // preview applies, the node's own array must pass through untouched so
  // selector sweeps don't allocate O(nodes) copies per store change.
  it('returns the same array reference when no preview applies', () => {
    const ids = ['assigned']
    expect(getCanvasNodeClassIds(ids, null, 'node-1')).toBe(ids)
    expect(getCanvasNodeClassIds(ids, { nodeId: 'node-2', classId: 'preview' }, 'node-1')).toBe(ids)
  })

  it('returns the same reference when the preview class is already assigned', () => {
    const ids = ['assigned', 'preview']
    expect(getCanvasNodeClassIds(ids, { nodeId: 'node-1', classId: 'preview' }, 'node-1')).toBe(ids)
  })

  it('returns undefined for empty or missing class lists', () => {
    expect(getCanvasNodeClassIds(undefined, null, 'node-1')).toBeUndefined()
    expect(getCanvasNodeClassIds([], null, 'node-1')).toBeUndefined()
  })

  it('appends a matching preview without mutating the original array', () => {
    const ids = ['assigned']
    const merged = getCanvasNodeClassIds(ids, { nodeId: 'node-1', classId: 'preview' }, 'node-1')
    expect(merged).toEqual(['assigned', 'preview'])
    expect(merged).not.toBe(ids)
    expect(ids).toEqual(['assigned'])
  })

  it('returns just the preview class when the node has none of its own', () => {
    expect(
      getCanvasNodeClassIds(undefined, { nodeId: 'node-1', classId: 'preview' }, 'node-1'),
    ).toEqual(['preview'])
  })
})
