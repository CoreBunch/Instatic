import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DataRow } from '@core/data/schemas'
import { savedLayoutFromRow, savedLayoutToCells } from '@core/data/layoutFromRow'
import { parseSavedLayout } from '@core/layouts'
import { makeConditionDef, type StyleRule } from '@core/page-tree'
import { generateClassCSS } from '@core/publisher'
import { cssToStyleRules } from '@core/siteImport'
import { collectSubtreeStyles, insertSnapshotSubtrees } from '@site/store/subtreeSnapshot'
import { CLIPBOARD_VERSION, readClipboardPayload, writeClipboardPayload } from '@site/store/clipboard/clipboardStorage'
import { makeNode, makePage, makeSite } from '../fixtures'

function sourceSite(css: string) {
  const parsed = cssToStyleRules(css, { breakpoints: [] })
  expect(parsed.warnings.filter((warning) => warning.kind !== 'duplicate-class')).toEqual([])
  const styleRules: Record<string, StyleRule> = Object.fromEntries(parsed.rules.map((rule, index) => {
    const id = `source-${index}`
    return [id, { ...rule, id, createdAt: 1, updatedAt: 1 }]
  }))
  const classIds = Object.values(styleRules).filter((rule) => rule.kind === 'class' && rule.name === 'card').map((rule) => rule.id)
  const nodes = { card: makeNode({ id: 'card', classIds }) }
  const site = makeSite({ styleRules, conditions: parsed.conditions, breakpoints: [] })
  site.conditions = parsed.conditions
  return { site, nodes }
}

describe('subtree CSS dependencies', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('captures grouping declarations, registered properties and animation dependencies in source order', () => {
    const { site, nodes } = sourceSite(`
      @layer base, theme;
      @property --accent { syntax: "<color>"; inherits: false; initial-value: teal; }
      @layer theme {
        .card { color: red; animation: pulse 1s; }
        @media (min-width: 500px) { .card { color: green !important; } }
        .orphan { color: orange; }
        .card { background-color: blue; }
      }
      @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    `)
    const snapshot = collectSubtreeStyles(nodes, site)
    const css = generateClassCSS(snapshot.classes, [], snapshot.conditions)
    expect(css).toContain('@layer base, theme;')
    expect(css).toContain('@property --accent')
    expect(css).toContain('@keyframes pulse')
    expect(css).toContain('@media (min-width: 500px)')
    expect(css).toContain('green !important')
    expect(css).not.toContain('.orphan')
    expect(css.indexOf('color: red')).toBeLessThan(css.indexOf('color: green'))
    expect(css.indexOf('color: green')).toBeLessThan(css.indexOf('background-color: blue'))
    const groupedRule = Object.values(snapshot.classes).find((rule) => rule.grouping?.length)
    expect(groupedRule).toBeDefined()
    groupedRule!.grouping![0].id = 'changed-snapshot-group'
    expect(site.styleRules[groupedRule!.id].grouping![0].id).not.toBe('changed-snapshot-group')
  })

  it('restores separate anonymous layers without colliding with destination groups', () => {
    const { site, nodes } = sourceSite(`
      @layer { .card { color: red; } }
      @layer { .card { background-color: blue; } }
    `)
    const snapshot = collectSubtreeStyles(nodes, site)
    const page = makePage()
    const existing: StyleRule = {
      id: 'existing', name: '', kind: 'ambient', selector: '', order: 100,
      styles: {}, contextStyles: {}, createdAt: 1, updatedAt: 1,
      atRule: { kind: 'group', group: { kind: 'layer', id: 'css-group:0', name: '' } },
    }
    const destination = makeSite({ styleRules: { existing }, conditions: [], breakpoints: [] })
    destination.conditions = []
    const roots = insertSnapshotSubtrees(page, destination, {
      rootNodeIds: ['card'], nodes, ...snapshot,
    }, { parentId: page.rootNodeId })
    expect(roots).toHaveLength(1)
    const restored = Object.fromEntries(Object.entries(destination.styleRules).filter(([id]) => id !== 'existing'))
    expect(generateClassCSS(restored, [], destination.conditions)).toBe(generateClassCSS(snapshot.classes, [], snapshot.conditions))
    const groupIds = new Set(Object.values(restored).flatMap((rule) => (rule.grouping ?? []).map((group) => group.id)))
    expect(groupIds.size).toBe(2)
    expect(groupIds.has('css-group:0')).toBe(false)
    expect(Object.values(restored).every((rule) => rule.order > 100)).toBe(true)
  })

  it('reuses equivalent conditions and preserves the source viewport query', () => {
    const { site, nodes } = sourceSite('@media (min-width: 700px) { .card { color: green; } }')
    site.breakpoints = [{ id: 'mobile', label: 'Mobile', width: 600, mediaQuery: '(max-width: 600px)', icon: 'smartphone' }]
    const rule = Object.values(site.styleRules).find((entry) => entry.kind === 'class')!
    rule.contextStyles.mobile = { padding: '7px' }
    rule.contextStylePriorities = { mobile: { padding: 'important' } }
    const snapshot = collectSubtreeStyles(nodes, site)
    const equivalent = { ...makeConditionDef({ kind: 'media', query: '(min-width: 700px)' }), id: 'target-wide' }
    const destination = makeSite({
      styleRules: {}, conditions: [equivalent],
      breakpoints: [{ id: 'mobile', label: 'Mobile', width: 375, mediaQuery: '(max-width: 375px)', icon: 'smartphone' }],
    })
    destination.conditions = [equivalent]
    const page = makePage()
    insertSnapshotSubtrees(page, destination, { rootNodeIds: ['card'], nodes, ...snapshot }, { parentId: page.rootNodeId })
    const restored = destination.styleRules[rule.id]
    expect(restored.grouping?.find((group) => group.kind === 'context')?.contextId).toBe('target-wide')
    const capturedViewport = destination.conditions!.find((entry) => entry.condition.query === '(max-width: 600px)')
    expect(capturedViewport).toBeDefined()
    expect(restored.contextStyles[capturedViewport!.id]).toEqual({ padding: '7px' })
    expect(restored.contextStylePriorities?.[capturedViewport!.id]).toEqual({ padding: 'important' })
    expect(destination.conditions!.filter((entry) => entry.condition.query === '(min-width: 700px)')).toHaveLength(1)
    expect(generateClassCSS(destination.styleRules, destination.breakpoints, destination.conditions)).toContain('(max-width: 600px)')
  })

  it('keeps a same-site scoped copy inside its source anonymous layer', () => {
    const { site, nodes } = sourceSite(`
      @layer { .card { color: red; } }
      @layer { .other { color: blue; } }
    `)
    const source = Object.values(site.styleRules).find((rule) => rule.kind === 'class' && rule.name === 'card')!
    source.scope = { type: 'node', nodeId: 'card', role: 'module-style' }
    const snapshot = collectSubtreeStyles(nodes, site)
    const page = makePage()
    const before = generateClassCSS(site.styleRules, [], site.conditions)
    const roots = insertSnapshotSubtrees(page, site, { rootNodeIds: ['card'], nodes, ...snapshot }, { parentId: page.rootNodeId })
    const copy = Object.values(site.styleRules).find((rule) => rule.scope?.nodeId === roots[0])!
    expect(copy.id).not.toBe(source.id)
    expect(copy.grouping).toEqual(source.grouping)
    const after = generateClassCSS(site.styleRules, [], site.conditions)
    expect(after.match(/@layer\s*\{/g)?.length).toBe(before.match(/@layer\s*\{/g)?.length)
    expect(copy.order).toBeGreaterThan(source.order)
    const nextGroup = Object.values(site.styleRules).filter((rule) => rule.order > source.order && rule.id !== copy.id).sort((a, b) => a.order - b.order)[0]
    expect(copy.order).toBeLessThan(nextGroup.order)
  })

  it('round-trips conditions and CSS through clipboard and stored layouts', () => {
    const { site, nodes } = sourceSite('@supports (display: grid) { .card { display: grid; } }')
    const snapshot = collectSubtreeStyles(nodes, site)
    writeClipboardPayload({ version: CLIPBOARD_VERSION, rootNodeIds: ['card'], nodes, ...snapshot, copiedAt: 1 })
    const clipboard = readClipboardPayload()
    expect(clipboard?.conditions).toEqual(snapshot.conditions)
    expect(clipboard?.classes).toEqual(snapshot.classes)
    const layout = parseSavedLayout({ id: 'layout', name: 'Card', rootNodeId: 'card', nodes, ...snapshot, createdAt: 1 })
    const row: DataRow = {
      id: 'layout', tableId: 'layouts', cells: savedLayoutToCells(layout), slug: 'card', status: 'draft',
      authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null,
      author: null, createdBy: null, updatedBy: null, publishedBy: null,
      createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
      publishedAt: null, scheduledPublishAt: null, deletedAt: null,
    }
    const restored = savedLayoutFromRow(row)
    expect(restored?.conditions).toEqual(snapshot.conditions)
    expect(generateClassCSS(restored!.classes, [], restored!.conditions)).toBe(generateClassCSS(snapshot.classes, [], snapshot.conditions))
  })

  it('rejects missing CSS contexts before mutating the destination', () => {
    const { site, nodes } = sourceSite('.card { color: red; }')
    const rule = Object.values(site.styleRules).find((entry) => entry.kind === 'class')!
    rule.grouping = [{ kind: 'context', id: 'group', contextId: 'missing' }]
    expect(() => collectSubtreeStyles(nodes, site)).toThrow('CSS context "missing" is missing')
    const page = makePage()
    const destination = makeSite({ styleRules: {}, conditions: [], breakpoints: [] })
    expect(() => insertSnapshotSubtrees(page, destination, {
      rootNodeIds: ['card'], nodes, classes: site.styleRules,
    }, { parentId: page.rootNodeId })).toThrow('CSS context "missing" is missing')
    expect(destination.styleRules).toEqual({})
    expect(page.nodes[page.rootNodeId].children).toEqual([])
  })
})
