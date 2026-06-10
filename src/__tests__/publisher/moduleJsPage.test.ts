import { describe, expect, it } from 'bun:test'
import type { SiteDocument } from '@core/page-tree'
import { publishPage, collectHoleSubtreeModuleIds } from '@core/publisher'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_p, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
  'test.jsy': makeModule('test.jsy', {
    render: () => ({ html: '<div></div>', js: 'JS_BODY' }),
  }),
  'test.live': makeModule('test.live', {
    canHaveChildren: true,
    dynamic: true,
    render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
  }),
})

describe('publishPage jsModuleIds', () => {
  it('reports modules that emitted js during the render, sorted', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['a'] },
      a: { moduleId: 'test.jsy' },
    })
    const site = makeSite({ pages: [page] })
    const { jsModuleIds } = publishPage(page, site, registry)
    expect(jsModuleIds).toEqual(['test.jsy'])
  })

  it('includes moduleIds inside hole subtrees even though they never rendered', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['live'] },
      live: { moduleId: 'test.live', children: ['inner'] },
      inner: { moduleId: 'test.jsy' },
    })
    const site = makeSite({ pages: [page] })
    const { html, jsModuleIds } = publishPage(page, site, registry)
    expect(html).toContain('<instatic-hole')
    expect(jsModuleIds).toEqual(['test.jsy', 'test.live'])
  })

  it('reports an empty list for pages with no js and no holes', () => {
    const page = makePage({ root: { moduleId: 'base.body', children: [] } })
    const site = makeSite({ pages: [page] })
    expect(publishPage(page, site, registry).jsModuleIds).toEqual([])
  })
})

describe('collectHoleSubtreeModuleIds', () => {
  it('descends into Visual Component definition trees (cycle-guarded)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['ref'] },
      ref: { moduleId: 'base.visual-component-ref', props: { componentId: 'vc-1' } },
    })
    const site = makeSite({
      pages: [page],
      visualComponents: [
        {
          id: 'vc-1',
          name: 'Test VC',
          tree: {
            rootNodeId: 'vc-root',
            nodes: {
              'vc-root': {
                id: 'vc-root',
                moduleId: 'test.jsy',
                props: {},
                children: [],
                breakpointOverrides: {},
                classIds: [],
              },
            },
          },
        } as unknown as SiteDocument['visualComponents'][number],
      ],
    })
    const ids = collectHoleSubtreeModuleIds(page, site, new Set(['ref']))
    expect(ids.has('base.visual-component-ref')).toBe(true)
    expect(ids.has('test.jsy')).toBe(true)
  })

  it('returns an empty set when there are no dynamic nodes', () => {
    const page = makePage({ root: { moduleId: 'base.body' } })
    const site = makeSite({ pages: [page] })
    expect(collectHoleSubtreeModuleIds(page, site, new Set()).size).toBe(0)
  })
})
