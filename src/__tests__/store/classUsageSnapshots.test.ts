import { describe, expect, it } from 'bun:test'
import { createUsedStyleRuleIdSelector, collectUsedStyleRuleIds } from '@core/publisher'
import { createSelectorUsageMapSelector } from '@site/panels/selectorUsage'
import { makeNode, makePage, makeSite, makeVC } from '../fixtures'

describe('class usage across immutable collaboration snapshots', () => {
  it('does not rescan unchanged trees when another row is projected', () => {
    let reads = 0
    const root = makeNode({ id: 'root', classIds: ['shared'] })
    const nodes = Object.defineProperty({}, 'root', { enumerable: true, get: () => { reads++; return root } })
    const page = makePage({ nodes, rootNodeId: 'root' })
    const other = makePage({ nodes: { second: makeNode({ id: 'second', classIds: ['before'] }) }, rootNodeId: 'second' })
    const site = makeSite({ pages: [page, other] })
    const selectIds = createUsedStyleRuleIdSelector()
    const selectCounts = createSelectorUsageMapSelector()
    expect(selectIds(site)).toBe('before\0shared')
    expect(selectCounts(site).get('shared')).toBe(1)
    const baseline = reads
    const changed = { ...site, pages: [page, { ...other, nodes: { second: makeNode({ id: 'second', classIds: ['after'] }) } }] }
    expect(selectIds(changed)).toBe('after\0shared')
    expect(selectCounts(changed).has('before')).toBe(false)
    expect(reads).toBe(baseline)
    expect(new Set(selectIds(changed).split('\0'))).toEqual(collectUsedStyleRuleIds(changed))
  })

  it('keeps counts referentially stable for text edits and handles removal and reload', () => {
    const root = makeNode({ id: 'root', classIds: ['shared', 'shared'] })
    const page = makePage({ nodes: { root }, rootNodeId: 'root' })
    const site = makeSite({ pages: [page] })
    const selectCounts = createSelectorUsageMapSelector()
    const initial = selectCounts(site)
    expect(initial.get('shared')).toBe(2)
    expect(selectCounts({ ...site, pages: [{ ...page, nodes: { root: { ...root, props: { text: 'changed' } } } }] })).toBe(initial)
    expect(selectCounts({ ...site, pages: [] }).size).toBe(0)
    expect(selectCounts(site).get('shared')).toBe(2)
    expect(selectCounts(null).size).toBe(0)
  })

  it('retains component and script references and invalidates replaced snapshots', () => {
    const node = makeNode({ id: 'root', classIds: ['component-node'] })
    const component = makeVC({ id: 'component', name: 'Component', classIds: ['component-shell'], tree: { rootNodeId: 'root', nodes: { root: node } } })
    const site = makeSite({
      visualComponents: [component],
      files: [{ id: 'runtime', path: 'runtime.js', type: 'script', content: "document.body.classList.add('open')", createdAt: 1, updatedAt: 1 }],
      styleRules: { scripted: { id: 'scripted', name: 'open', selector: '.open', kind: 'class', order: 0, styles: {}, contextStyles: {}, createdAt: 1, updatedAt: 1 } },
    })
    const selectIds = createUsedStyleRuleIdSelector()
    expect(selectIds(site)).toBe([...collectUsedStyleRuleIds(site)].sort().join('\0'))
    const changed = { ...site, visualComponents: [{ ...component, classIds: ['changed-shell'], tree: { ...component.tree, nodes: { root: { ...node, classIds: ['changed-node'] } } } }] }
    expect(selectIds(changed)).toBe('changed-node\0changed-shell\0scripted')
    expect(selectIds({ ...changed, files: [] })).toBe('changed-node\0changed-shell')
    expect(selectIds(site)).toBe('component-node\0component-shell\0scripted')
  })
})
