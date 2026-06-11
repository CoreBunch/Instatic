/**
 * Saved-layout validation at the persistence boundary.
 *
 *   validateSavedLayouts                — tolerant LOAD path (drop + repair)
 *   validateSavedLayoutsForPartialWrite — strict WRITE path (throw)
 *
 * Mirrors visualComponentsWriteValidation.test.ts for the layouts roster.
 */

import { describe, expect, it } from 'bun:test'
import { SiteValidationError } from '@core/persistence/validate'
import {
  validateSavedLayouts,
  validateSavedLayoutsForPartialWrite,
} from '@core/persistence/validateLayouts'
import type { SavedLayout } from '@core/layouts'

function layout(overrides: Partial<SavedLayout> = {}): SavedLayout {
  return {
    id: 'layout-hero',
    name: 'Hero',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.container',
        props: {},
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
    classes: {},
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('validateSavedLayouts (load path)', () => {
  it('passes valid layouts through and derives parent indexes', () => {
    const result = validateSavedLayouts([layout()])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Hero')
  })

  it('silently drops malformed entries and incoherent trees', () => {
    const incoherent = layout({
      id: 'layout-broken',
      name: 'Broken',
      // Root's child id doesn't resolve — tree invariant failure.
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.container',
          props: {},
          breakpointOverrides: {},
          children: ['ghost'],
          classIds: [],
        },
      },
    })
    const result = validateSavedLayouts([layout(), 'garbage', incoherent])
    expect(result.map((l) => l.id)).toEqual(['layout-hero'])
  })

  it('dedupes by name, first wins', () => {
    const dupe = layout({ id: 'layout-2' })
    const result = validateSavedLayouts([layout(), dupe])
    expect(result.map((l) => l.id)).toEqual(['layout-hero'])
  })

  it('sanitizes richtext-keyed props in snapshot nodes', () => {
    const dirty = layout({
      nodes: {
        root: {
          id: 'root',
          moduleId: 'base.text',
          props: { richtext: '<p>ok</p><script>alert(1)</script>' },
          breakpointOverrides: {},
          children: [],
          classIds: [],
        },
      },
    })
    const result = validateSavedLayouts([dirty])
    expect(String(result[0].nodes.root.props.richtext)).not.toContain('<script>')
  })
})

describe('validateSavedLayoutsForPartialWrite (write path)', () => {
  it('returns the parsed changed batch', () => {
    const result = validateSavedLayoutsForPartialWrite([layout({ name: '  Hero  ' })], [], new Set(['layout-hero']))
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Hero')
  })

  it('throws on a malformed layout instead of dropping it', () => {
    expect(() => validateSavedLayoutsForPartialWrite([{ id: 'x' }], [], new Set()))
      .toThrow(SiteValidationError)
  })

  it('throws when a changed layout duplicates a kept stored name', () => {
    const stored = layout({ id: 'layout-old' })
    const incoming = layout({ id: 'layout-new' }) // same name "Hero"
    expect(() =>
      validateSavedLayoutsForPartialWrite([incoming], [stored], new Set(['layout-old', 'layout-new'])),
    ).toThrow(SiteValidationError)
  })

  it('allows replacing a stored layout by id with the same name', () => {
    const stored = layout()
    const incoming = layout() // same id — replaces in the merged roster
    const result = validateSavedLayoutsForPartialWrite([incoming], [stored], new Set(['layout-hero']))
    expect(result).toHaveLength(1)
  })

  it('ignores stored rows missing from keptIds when checking identity', () => {
    const stored = layout({ id: 'layout-old' })
    const incoming = layout({ id: 'layout-new' }) // same name, but old row is being reaped
    const result = validateSavedLayoutsForPartialWrite([incoming], [stored], new Set(['layout-new']))
    expect(result).toHaveLength(1)
  })
})
