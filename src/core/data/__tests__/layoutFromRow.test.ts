import { describe, expect, it } from 'bun:test'
import type { DataRow } from '@core/data/schemas'
import { layoutSlugFromName, savedLayoutFromRow, savedLayoutToCells } from '@core/data/layoutFromRow'
import type { SavedLayout } from '@core/layouts'

function makeLayout(): SavedLayout {
  return {
    id: 'layout-1',
    name: 'Hero Section',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.container',
        props: { gap: 8 },
        breakpointOverrides: {},
        children: [],
        classIds: ['cls-a'],
      },
    },
    classes: {
      'cls-a': {
        id: 'cls-a',
        name: 'hero-style',
        kind: 'class',
        selector: '.hero-style',
        order: 0,
        styles: {},
        contextStyles: {},
        createdAt: 1000,
        updatedAt: 1000,
      },
    },
    createdAt: 1_700_000_000_000,
  }
}

function rowFor(layout: SavedLayout): DataRow {
  return {
    id: layout.id,
    tableId: 'layouts',
    cells: savedLayoutToCells(layout),
    slug: layoutSlugFromName(layout.name),
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

describe('savedLayoutToCells / savedLayoutFromRow', () => {
  it('round-trips a layout through the data_rows cell shape', () => {
    const layout = makeLayout()
    const restored = savedLayoutFromRow(rowFor(layout))

    expect(restored).not.toBeNull()
    expect(restored!.id).toBe(layout.id)
    expect(restored!.name).toBe(layout.name)
    expect(restored!.rootNodeId).toBe(layout.rootNodeId)
    expect(restored!.nodes.root.props).toEqual({ gap: 8 })
    expect(restored!.nodes.root.classIds).toEqual(['cls-a'])
    expect(restored!.classes['cls-a']?.selector).toBe('.hero-style')
    // createdAt comes from the row's ISO timestamp.
    expect(restored!.createdAt).toBe(Date.parse('2026-06-01T00:00:00.000Z'))
  })

  it('returns null for a row whose body cell is corrupt', () => {
    const row = rowFor(makeLayout())
    const corrupt: DataRow = { ...row, cells: { ...row.cells, body: 'not a tree' } }
    expect(savedLayoutFromRow(corrupt)).toBeNull()
  })
})

describe('layoutSlugFromName', () => {
  it('kebab-cases and falls back on empty input', () => {
    expect(layoutSlugFromName('Hero Section')).toBe('hero-section')
    expect(layoutSlugFromName('  Fancy Footer!  ')).toBe('fancy-footer')
    expect(layoutSlugFromName('!!!')).toBe('layout')
  })
})
