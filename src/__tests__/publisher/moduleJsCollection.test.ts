import { describe, expect, it } from 'bun:test'
import { renderNode } from '@core/publisher'
import type { RenderConfig } from '@core/publisher'
import { makeAccumulators, makeModule, makePage, makeRegistry, makeSite } from './helpers'

describe('renderNode module-JS collection', () => {
  it('collects render() js once per moduleId (deduped like CSS)', () => {
    const registry = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_p, children) => ({ html: children.join('') }),
      }),
      'test.jsy': makeModule('test.jsy', {
        render: () => ({ html: '<div></div>', js: 'JS_BODY' }),
      }),
    })
    const page = makePage({
      root: { moduleId: 'base.body', children: ['a', 'b'] },
      a: { moduleId: 'test.jsy' },
      b: { moduleId: 'test.jsy' },
    })
    const site = makeSite({ pages: [page] })
    const config: RenderConfig = { page, site, registry, breakpointId: undefined }
    const acc = makeAccumulators()

    renderNode('root', config, acc)

    expect([...acc.jsMap.entries()]).toEqual([['test.jsy', 'JS_BODY']])
  })

  it('leaves jsMap empty when no module emits js', () => {
    const registry = makeRegistry({
      'test.plain': makeModule('test.plain'),
    })
    const page = makePage({ root: { moduleId: 'test.plain' } })
    const site = makeSite({ pages: [page] })
    const config: RenderConfig = { page, site, registry, breakpointId: undefined }
    const acc = makeAccumulators()

    renderNode('root', config, acc)

    expect(acc.jsMap.size).toBe(0)
  })
})
