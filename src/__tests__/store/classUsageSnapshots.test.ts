import { describe, expect, it } from 'bun:test'
import { createSelectorUsageMapSelector } from '@site/panels/selectorUsage'
import { makeNode, makePage, makeSite } from '../fixtures'

describe('class usage across immutable collaboration snapshots', () => {
  it('does not rescan unchanged trees when another row is projected', () => {
    let reads = 0
    const root = makeNode({ id: 'root', classIds: ['shared'] })
    const nodes = Object.defineProperty({}, 'root', { enumerable: true, get: () => { reads++; return root } })
    const page = makePage({ nodes, rootNodeId: 'root' })
    const other = makePage({ nodes: { second: makeNode({ id: 'second', classIds: ['before'] }) }, rootNodeId: 'second' })
    const site = makeSite({ pages: [page, other] })
    const selectCounts = createSelectorUsageMapSelector()
    expect(selectCounts(site).get('shared')).toBe(1)
    const baseline = reads
    const changed = { ...site, pages: [page, { ...other, nodes: { second: makeNode({ id: 'second', classIds: ['after'] }) } }] }
    expect(selectCounts(changed).has('before')).toBe(false)
    expect(selectCounts(changed).get('after')).toBe(1)
    expect(reads).toBe(baseline)
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

})
