/**
 * Phase 0 — Selectors System: ambient style rule tests.
 *
 * Covers the runtime behaviour the model extension unlocks:
 *   - `createAmbientRule` writes a kind:'ambient' entry with the verbatim
 *     selector and a cascade `order` strictly greater than every existing rule.
 *   - `addNodeClass` refuses an ambient classId (the invariant that
 *     `node.classIds` only holds class-kind ids — otherwise the publisher
 *     would emit a selector like `h1 > span` as a class-attribute token).
 *   - `classNamesForClassIds` filters ambient ids out of the class attribute.
 *   - The publisher's `collectClassCSS` includes every ambient rule even when
 *     no node references it via `classIds` (tree-shaking by classIds alone
 *     would silently drop ambient rules).
 *   - Cascade order: `generateClassCSS` emits rules in ascending `order`.
 */

import { describe, it, expect } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { classNamesForClassIds } from '@core/page-tree'
import { collectClassCSS, generateClassCSS } from '@core/publisher'
import type { StyleRule } from '@core/page-tree'
import '@modules/base'

type CssSupportsGlobal = {
  CSS?: {
    supports: (conditionText: string) => boolean
  }
}

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    hasUnsavedChanges: false,
  })
  useEditorStore.getState().createSite('Test')
}

function withCssSupports(
  supports: (conditionText: string) => boolean,
  run: () => void,
) {
  const cssGlobal = globalThis as CssSupportsGlobal
  const originalCss = cssGlobal.CSS
  cssGlobal.CSS = { supports }
  try {
    run()
  } finally {
    if (originalCss === undefined) {
      delete cssGlobal.CSS
    } else {
      cssGlobal.CSS = originalCss
    }
  }
}

describe('createAmbientRule', () => {
  it('creates a kind:"ambient" rule with the verbatim selector', () => {
    freshStore()
    const rule = useEditorStore
      .getState()
      .createAmbientRule({ selector: 'h1 > span', styles: { color: 'red' } })

    expect(rule.kind).toBe('ambient')
    expect(rule.selector).toBe('h1 > span')
    expect(rule.styles).toEqual({ color: 'red' })
    expect(rule.name).toBe('h1 > span') // defaults to selector text
  })

  it('uses the explicit name when provided', () => {
    freshStore()
    const rule = useEditorStore.getState().createAmbientRule({
      selector: '.hero .title',
      name: 'Hero headline',
    })
    expect(rule.name).toBe('Hero headline')
    expect(rule.selector).toBe('.hero .title')
  })

  it('rejects an empty or whitespace-only selector', () => {
    freshStore()
    expect(() =>
      useEditorStore.getState().createAmbientRule({ selector: '   ' }),
    ).toThrow('Ambient selector cannot be empty')
  })

  it('rejects a syntactically invalid selector', () => {
    freshStore()
    expect(() =>
      useEditorStore.getState().createAmbientRule({ selector: 'h1 >>> span' }),
    ).toThrow('Invalid CSS selector')
  })

  it('uses browser selector support to reject unknown pseudo-classes', () => {
    freshStore()
    withCssSupports((conditionText) => {
      if (conditionText === 'selector(*)') return true
      if (conditionText === 'selector(.a)') return true
      if (conditionText === 'selector(input:placeholder)') return false
      if (conditionText === 'selector(input::placeholder)') return true
      return false
    }, () => {
      const store = useEditorStore.getState()
      expect(() => store.createAmbientRule({ selector: 'input:placeholder' })).toThrow(
        'Invalid CSS selector',
      )
      expect(() => store.createAmbientRule({ selector: '.a, input:placeholder' })).toThrow(
        'Invalid CSS selector',
      )
      const rule = store.createAmbientRule({ selector: 'input::placeholder' })
      expect(rule.selector).toBe('input::placeholder')
      const listRule = store.createAmbientRule({ selector: '.a, input::placeholder' })
      expect(listRule.selector).toBe('.a, input::placeholder')
    })
  })

  it('appends to the cascade — order strictly greater than every existing rule', () => {
    freshStore()
    const store = useEditorStore.getState()
    const a = store.createClass('a', { color: 'a' })
    const b = store.createClass('b', { color: 'b' })
    const amb = store.createAmbientRule({ selector: 'h1' })
    expect(amb.order).toBeGreaterThan(a.order!)
    expect(amb.order).toBeGreaterThan(b.order!)
  })
})

describe('rename ambient rule', () => {
  it('keeps name and selector aligned to the edited selector', () => {
    freshStore()
    const store = useEditorStore.getState()
    const rule = store.createAmbientRule({ selector: '.auth-back:hover' })

    store.renameClass(rule.id, '.auth-back:focus')

    const renamed = useEditorStore.getState().site!.styleRules[rule.id]
    expect(renamed.name).toBe('.auth-back:focus')
    expect(renamed.selector).toBe('.auth-back:focus')
  })
})

describe('node.classIds → class attribute', () => {
  it('classNamesForClassIds filters ambient rules', () => {
    freshStore()
    const cls = useEditorStore.getState().createClass('hero')
    const amb = useEditorStore.getState().createAmbientRule({ selector: 'h1' })

    const site = useEditorStore.getState().site!
    expect(classNamesForClassIds(site.styleRules, [cls.id, amb.id])).toEqual(['hero'])
  })

  it('addNodeClass refuses ambient ids and does not mutate the node', () => {
    freshStore()
    const store = useEditorStore.getState()
    const site = store.site!
    const rootId = site.pages[0].rootNodeId
    const amb = store.createAmbientRule({ selector: 'h1' })

    const before = store.site!.pages[0].nodes[rootId].classIds ?? []
    store.addNodeClass(rootId, amb.id)
    const after = store.site!.pages[0].nodes[rootId].classIds ?? []
    expect(after).toEqual(before)
    expect(after).not.toContain(amb.id)
  })
})

describe('publisher emits ambient rules', () => {
  it('collectClassCSS includes ambient rules even when no node references them', () => {
    freshStore()
    useEditorStore.getState().createAmbientRule({
      selector: 'h1 > span',
      styles: { color: '#f00' },
    })

    // Re-read state AFTER the mutation — `getState()` returns an immutable
    // snapshot, not a live ref.
    const css = collectClassCSS(useEditorStore.getState().site!)
    expect(css).toContain('h1 > span')
    expect(css).toContain('color: #f00')
  })

  it('emits rules in cascade order (ascending `order` field)', () => {
    // Direct call into generateClassCSS gives a deterministic ordering view
    // without depending on classSlice's internal append-at-end behavior.
    const now = Date.now()
    const make = (id: string, name: string, order: number, color: string): StyleRule => ({
      id,
      name,
      kind: 'class',
      selector: `.${name}`,
      order,
      styles: { color },
      contextStyles: {},
      createdAt: now,
      updatedAt: now,
    })
    const classes: Record<string, StyleRule> = {
      late: make('late', 'late', 99, '#late'),
      early: make('early', 'early', 1, '#early'),
      middle: make('middle', 'middle', 50, '#middle'),
    }

    const css = generateClassCSS(classes, [])
    const earlyIdx = css.indexOf('.early')
    const middleIdx = css.indexOf('.middle')
    const lateIdx = css.indexOf('.late')
    expect(earlyIdx).toBeGreaterThan(-1)
    expect(middleIdx).toBeGreaterThan(earlyIdx)
    expect(lateIdx).toBeGreaterThan(middleIdx)
  })

  it('emits the verbatim selector for ambient rules (not `.${name}`)', () => {
    const now = Date.now()
    const cls: StyleRule = {
      id: 'a',
      name: 'a-name',
      kind: 'ambient',
      selector: 'a:hover',
      order: 0,
      styles: { color: '#abc' },
      contextStyles: {},
      createdAt: now,
      updatedAt: now,
    }
    const css = generateClassCSS({ a: cls }, [])
    expect(css).toContain('a:hover {')
    // The `name` field should NOT bleed into the selector.
    expect(css).not.toContain('.a-name')
  })
})

describe('parseStyleRule persisted shape', () => {
  it('drops rules missing current selector metadata', async () => {
    const { parseStyleRule } = await import('@core/page-tree')
    expect(parseStyleRule({
      id: 'x',
      name: 'legacy-name',
      styles: { color: 'red' },
      createdAt: 0,
      updatedAt: 0,
    })).toBeNull()
  })

  it('keeps sparse declaration priorities and drops invalid or orphaned entries', async () => {
    const { parseStyleRule } = await import('@core/page-tree')
    const parsed = parseStyleRule({
      id: 'x',
      name: 'x',
      kind: 'class',
      selector: '.x',
      order: 0,
      styles: { color: 'red' },
      stylePriorities: { color: 'important', gap: 'important', display: 'normal' },
      contextStyles: { mobile: { color: 'blue' } },
      contextStylePriorities: {
        mobile: { color: 'important', gap: 'important' },
        orphan: { color: 'important' },
      },
      createdAt: 0,
      updatedAt: 0,
    })

    expect(parsed?.stylePriorities).toEqual({ color: 'important' })
    expect(parsed?.contextStylePriorities).toEqual({ mobile: { color: 'important' } })
  })
})
