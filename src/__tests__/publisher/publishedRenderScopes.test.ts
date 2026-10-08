import { describe, expect, it } from 'bun:test'
import { publishedRenderScopes } from '@core/templates'
import { walkRenderTree } from '@core/visualComponents'
import type { Page } from '@core/page-tree'
import { makePage, makeSite } from './helpers'

function page(id: string, outlet = false): Page {
  const result = makePage({
    [id]: { moduleId: 'base.body', children: outlet ? [`${id}-outlet`, `${id}-copy`] : [`${id}-copy`] },
    ...(outlet ? { [`${id}-outlet`]: { moduleId: 'base.outlet' } } : {}),
    [`${id}-copy`]: { moduleId: 'base.text', props: { text: id } },
  }, id)
  result.id = id
  return result
}
function text(value: Page): unknown[] {
  const result: unknown[] = []
  walkRenderTree(value.nodes, value.rootNodeId, [], (node) => {
    if (node.moduleId === 'base.text') result.push(node.props.text)
  })
  return result
}

describe('native public render scopes', () => {
  it('emits actual pages with their effective layout and keeps authoritative terminal metadata', () => {
    const first = page('first'), second = page('second'), layout = page('layout', true), unused = page('unused', true)
    first.title = 'First title'
    layout.template = { enabled: true, target: { kind: 'everywhere' }, priority: 2 }
    unused.template = { enabled: true, target: { kind: 'everywhere' }, priority: 1 }
    const scopes = [...publishedRenderScopes(makeSite({ pages: [first, second, layout, unused] }))]
    expect(scopes.map((scope) => scope.kind)).toEqual(['page', 'page'])
    expect(text(scopes[0]!.page)).toEqual(['first', 'layout'])
    expect(scopes[0]!.page.title).toBe('First title')
    expect(scopes[0]!.kind !== 'entry' && scopes[0]!.sourcePage).toBe(first)
    expect(JSON.stringify(scopes)).not.toContain('unused-copy')
  })

  it('includes only the winning 404 composed with the page layout', () => {
    const layout = page('layout', true), winner = page('winning-404'), loser = page('losing-404')
    layout.template = { enabled: true, target: { kind: 'everywhere' }, priority: 0 }
    winner.template = { enabled: true, target: { kind: 'notFound' }, priority: 1 }
    loser.template = { enabled: true, target: { kind: 'notFound' }, priority: 0 }
    const scopes = [...publishedRenderScopes(makeSite({ pages: [layout, winner, loser] }))]
    expect(scopes).toHaveLength(1)
    expect(scopes[0]!.kind).toBe('notFound')
    expect(text(scopes[0]!.page)).toEqual(['winning-404', 'layout'])
    expect(scopes[0]!.kind !== 'entry' && scopes[0]!.sourcePage).toBe(winner)
  })

  it('enumerates each declared entry scope once using priority and document order', () => {
    const layout = page('layout', true), winner = page('entries', true), loser = page('unused-entries', true)
    layout.template = { enabled: true, target: { kind: 'everywhere' }, priority: 0 }
    winner.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts', 'news', 'posts'] }, priority: 1 }
    loser.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 1 }
    const scopes = [...publishedRenderScopes(makeSite({ pages: [layout, winner, loser] }))]
    expect(scopes.map((scope) => scope.kind === 'entry' && scope.tableSlug)).toEqual(['posts', 'news'])
    for (const scope of scopes) expect(text(scope.page)).toEqual(['entries', 'layout'])
    expect(JSON.stringify(scopes)).not.toContain('unused-entries-copy')
  })

  it('omits outletless layouts for pages but preserves native entry chrome without an outlet', () => {
    const ordinary = page('ordinary'), layout = page('unfinished-layout'), entry = page('entry-chrome')
    layout.template = { enabled: true, target: { kind: 'everywhere' }, priority: 0 }
    entry.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 }
    const scopes = [...publishedRenderScopes(makeSite({ pages: [ordinary, layout, entry] }))]
    expect(scopes).toHaveLength(2)
    expect(scopes[0]!.page).toBe(ordinary)
    expect(text(scopes[1]!.page)).toEqual(['entry-chrome'])
  })

  it('does not mutate authored trees or emit a disabled template as an entry scope', () => {
    const disabled = page('disabled')
    disabled.template = { enabled: false, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 }
    const site = makeSite({ pages: [disabled] })
    const before = structuredClone(site)
    expect([...publishedRenderScopes(site)].map((scope) => scope.kind)).toEqual(['page'])
    expect(site).toEqual(before)
  })
})
