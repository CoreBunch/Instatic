import { describe, expect, it } from 'bun:test'
import { layoutNameError, parseSavedLayout, type SavedLayout } from '@core/layouts'

function rawLayout(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'layout-1',
    name: 'Hero',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.container',
        props: { gap: 12 },
        breakpointOverrides: {},
        children: ['text'],
        classIds: ['cls-a'],
      },
      text: {
        id: 'text',
        moduleId: 'base.text',
        props: { text: 'Hi' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
    classes: {
      'cls-a': {
        id: 'cls-a',
        name: 'hero-style',
        kind: 'class',
        selector: '.hero-style',
        order: 0,
        styles: { color: 'var(--x)' },
        contextStyles: {},
        createdAt: 1000,
        updatedAt: 1000,
      },
    },
    createdAt: 1234,
    ...overrides,
  }
}

describe('parseSavedLayout', () => {
  it('round-trips a valid layout', () => {
    const layout = parseSavedLayout(rawLayout())
    expect(layout).not.toBeNull()
    expect(layout!.id).toBe('layout-1')
    expect(layout!.name).toBe('Hero')
    expect(layout!.rootNodeId).toBe('root')
    expect(Object.keys(layout!.nodes).sort()).toEqual(['root', 'text'])
    expect(layout!.nodes.text.props.text).toBe('Hi')
    expect(layout!.classes['cls-a']?.name).toBe('hero-style')
    expect(layout!.createdAt).toBe(1234)
    // parentId index is derived from the children arrays.
    expect(layout!.nodes.text.parentId).toBe('root')
  })

  it('drops structurally invalid nodes instead of rejecting the layout', () => {
    const layout = parseSavedLayout(rawLayout({
      nodes: {
        ...(rawLayout().nodes as Record<string, unknown>),
        broken: { props: {} }, // no id / moduleId
      },
    }))
    expect(layout).not.toBeNull()
    expect(Object.keys(layout!.nodes).sort()).toEqual(['root', 'text'])
  })

  it('returns null when the root node is missing from the parsed map', () => {
    expect(parseSavedLayout(rawLayout({ rootNodeId: 'nope' }))).toBeNull()
  })

  it('returns null for missing identity fields', () => {
    expect(parseSavedLayout(rawLayout({ id: '' }))).toBeNull()
    expect(parseSavedLayout(rawLayout({ name: '' }))).toBeNull()
    expect(parseSavedLayout('not an object')).toBeNull()
  })

  it('drops invalid classes and falls back createdAt', () => {
    const layout = parseSavedLayout(rawLayout({
      classes: { junk: { id: 'junk' } }, // missing required StyleRule fields
      createdAt: 'yesterday',
    }))
    expect(layout).not.toBeNull()
    expect(layout!.classes).toEqual({})
    expect(typeof layout!.createdAt).toBe('number')
  })
})

describe('layoutNameError', () => {
  const existing: Array<Pick<SavedLayout, 'id' | 'name'>> = [
    { id: 'a', name: 'Hero' },
    { id: 'b', name: 'Footer' },
  ]

  it('rejects empty and whitespace-only names', () => {
    expect(layoutNameError('', existing)).not.toBeNull()
    expect(layoutNameError('   ', existing)).not.toBeNull()
  })

  it('rejects duplicates (after trimming) but allows renaming to own name', () => {
    expect(layoutNameError(' Hero ', existing)).not.toBeNull()
    expect(layoutNameError('Hero', existing, 'a')).toBeNull()
    expect(layoutNameError('Sidebar', existing)).toBeNull()
  })
})
