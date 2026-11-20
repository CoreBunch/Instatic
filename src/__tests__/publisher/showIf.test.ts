/**
 * Show-if conditions (`showIf` prop, `@core/templates/showIf`): an element is
 * rendered only when a query parameter, or a field of the loop item, passes
 * a test. Query conditions make the node request-dependent (rule 2c).
 */

import { describe, expect, it } from 'bun:test'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'
import { publishPage, type ResolvedLoopRenderData } from '@core/publisher'
import { buildRouteFrame, readShowIf, showIfAllows } from '@core/templates'
import { findDynamicNodeIds } from '../../core/publisher/dynamicDetection'
import type { LoopItem } from '@core/loops/types'

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
  'base.text': makeModule('base.text', {
    render: (props) => ({ html: `<p>${String((props as { text: string }).text)}</p>` }),
  }),
  'base.loop': makeModule('base.loop', { canHaveChildren: true, render: () => ({ html: '' }) }),
})

function loopData(items: LoopItem[]): ResolvedLoopRenderData {
  return { items, totalItems: items.length, pageNumber: 1, hasMore: false }
}

describe('show-if conditions', () => {
  it('reads conditions, and an unreadable one as never', () => {
    expect(readShowIf({})).toBeNull()
    expect(readShowIf({ showIf: { source: 'query', name: 'commerce', test: 'filled' } }))
      .toEqual({ source: 'query', name: 'commerce', test: 'filled' })
    expect(readShowIf({ showIf: { source: 'query', name: '', test: 'filled' } })).toBe('never')
    expect(readShowIf({ showIf: { source: 'cookie', name: 'x', test: 'filled' } })).toBe('never')
    expect(showIfAllows('never', { entryStack: [] })).toBe(false)
  })

  it('tests a query parameter of the address', () => {
    const route = buildRouteFrame('https://example.com/account?commerce=plan_changed')
    const context = { entryStack: [], route }
    const is = (test: 'equals' | 'notEquals' | 'filled' | 'empty', value?: string) =>
      showIfAllows({ source: 'query', name: 'commerce', test, ...(value !== undefined ? { value } : {}) }, context)
    expect(is('equals', 'plan_changed')).toBe(true)
    expect(is('equals', 'cancelled')).toBe(false)
    expect(is('notEquals', 'cancelled')).toBe(true)
    expect(is('filled')).toBe(true)
    expect(is('empty')).toBe(false)
    expect(showIfAllows({ source: 'query', name: 'other', test: 'empty' }, context)).toBe(true)
  })

  it('renders an element inside a loop only for the items that pass', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['row'], props: { sourceId: 'test' } },
      row: { moduleId: 'base.text', children: [], props: { text: '' }, dynamicBindings: { text: { source: 'currentEntry', field: 'name' } } },
    })
    page.nodes.row!.props.showIf = { source: 'entry', name: 'status', test: 'equals', value: 'active' }
    const items: LoopItem[] = [
      { id: 'a', fields: { name: 'Alpha', status: 'active' } },
      { id: 'b', fields: { name: 'Beta', status: 'paused' } },
      { id: 'c', fields: { name: 'Gamma', status: 'active' } },
    ]
    const html = publishPage(page, makeSite(), registry, { loopData: new Map([['loop', loopData(items)]]) }).html
    expect(html).toContain('<p>Alpha</p>')
    expect(html).toContain('<p>Gamma</p>')
    expect(html).not.toContain('Beta')
  })

  it('renders a query condition against the request it is rendered for', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['notice'] },
      notice: { moduleId: 'base.text', props: { text: 'PLAN-CHANGED', showIf: { source: 'query', name: 'commerce', test: 'equals', value: 'plan_changed' } } },
    })
    const render = (url: string) => publishPage(page, makeSite(), registry, {
      dynamicNodes: 'inline',
      templateContext: { entryStack: [], route: buildRouteFrame(url) },
    }).html
    expect(render('https://example.com/account?commerce=plan_changed')).toContain('PLAN-CHANGED')
    expect(render('https://example.com/account')).not.toContain('PLAN-CHANGED')
  })

  it('makes a query condition request-dependent and leaves an entry condition static', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['byQuery', 'byField'] },
      byQuery: { moduleId: 'base.text', props: { text: 'q', showIf: { source: 'query', name: 'commerce', test: 'filled' } } },
      byField: { moduleId: 'base.text', props: { text: 'f', showIf: { source: 'entry', name: 'status', test: 'filled' } } },
    })
    const dynamic = findDynamicNodeIds(page, makeSite(), registry)
    expect(dynamic.has('byQuery')).toBe(true)
    expect(dynamic.has('byField')).toBe(false)
  })

  it('reads only own values, never Object.prototype members', () => {
    const context = { entryStack: [{ id: 'a', fields: { status: 'x' } }], route: buildRouteFrame('https://example.com/') }
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(showIfAllows({ source: 'query', name, test: 'empty' }, context)).toBe(true)
      expect(showIfAllows({ source: 'entry', name, test: 'empty' }, context)).toBe(true)
    }
  })

})
