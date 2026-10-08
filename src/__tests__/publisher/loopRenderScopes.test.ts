import { describe, expect, it } from 'bun:test'
import { assertPageLoopScopes, assertSiteLoopScopes, LoopScopeConfigurationError, publishPage } from '@core/publisher'
import { ModulePropsValidationError, registry } from '@core/module-engine'
import { publishedLoopSite } from '../helpers/publishedLoopFixture'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'

describe('native infinite-loop publication scopes', () => {
  it('fills missing captions through the native schema but rejects an invalid bound caption', () => {
    const page = makePage({ nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['loop'] }),
      loop: makeNode({ id: 'loop', moduleId: 'base.loop', props: { pagination: 'infinite' }, children: ['text'] }),
      text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: '{currentEntry.title}' } }),
    } })
    const site = makeSite({ pages: [page] })
    const data = { items: [{ id: 'item', fields: { title: 'Item' } }], totalItems: 2, pageNumber: 1, hasMore: true }
    const options = { loopData: new Map([['loop', data]]), templateContext: { entryStack: [{ id: 'parent', fields: { caption: { invalid: true } } }] } }
    expect(publishPage(page, site, registry, options).html).toContain('data-instatic-loop-load-more-label="Load more"')
    page.nodes.loop.dynamicBindings = { loadMoreLabel: { source: 'currentEntry', field: 'caption' } }
    expect(() => publishPage(page, site, registry, options)).toThrow(ModulePropsValidationError)
    expect(() => publishPage(page, site, registry, options)).toThrow('/props/loadMoreLabel')
  })

  it('rejects a pagination overlay before it can activate a mode absent from prefetch', () => {
    const page = makePage({ title: 'infinite', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outer'] }),
      outer: makeNode({ id: 'outer', moduleId: 'base.loop', props: { pagination: 'none' }, children: ['inner'] }),
      inner: makeNode({ id: 'inner', moduleId: 'base.loop', props: { pagination: 'none' }, children: ['text'],
        dynamicBindings: { pagination: { source: 'page', field: 'title' } } }),
      text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: '{currentEntry.title}' } }),
    } })
    const site = makeSite({ pages: [page] })
    expect(() => assertSiteLoopScopes(site)).toThrow(LoopScopeConfigurationError)
    expect(() => publishPage(page, site, registry)).toThrow('authored source configuration "pagination"')
    try { assertPageLoopScopes(page, site) } catch (error) {
      expect(error).toHaveProperty('path', `pages.${page.id}.nodes.inner.dynamicBindings.pagination`)
    }
  })

  it.each(['sourceId', 'filters', 'orderBy', 'direction', 'limit', 'offset', 'pagination', 'pageSize'])('rejects an inline token on authored %s configuration before rendering', (propKey) => {
    const page = makePage({ title: 'infinite', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outer'] }),
      outer: makeNode({ id: 'outer', moduleId: 'base.loop', props: { pagination: 'none' }, children: ['inner'] }),
      inner: makeNode({ id: 'inner', moduleId: 'base.loop', props: { pagination: 'none', [propKey]: '{page.title}' } }),
    } })
    const site = makeSite({ pages: [page] })
    expect(() => assertSiteLoopScopes(site)).toThrow(LoopScopeConfigurationError)
    expect(() => publishPage(page, site, registry)).toThrow(`authored source configuration "${propKey}"`)
    try { assertPageLoopScopes(page, site) } catch (error) {
      expect(error).toHaveProperty('path', `pages.${page.id}.nodes.inner.props.${propKey}`)
    }
  })

  it('allows the same component in nine separate routes and preserves an entry route seed', () => {
    const site = publishedLoopSite()
    expect(() => assertSiteLoopScopes(site)).not.toThrow()
    const entry = structuredClone(site.pages[1])
    entry.id = 'entry'
    delete entry.translationGroup
    entry.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 1 }
    site.pages.push(entry)
    expect(() => assertSiteLoopScopes(site)).not.toThrow()
    const output = publishPage(entry, site, registry, {
      templateContext: { entryStack: [{ id: 'parent', fields: { title: 'Published parent' } }] },
      loopData: new Map([['shared-loop', { items: [{ id: 'child', fields: { title: 'Child' } }], totalItems: 2, pageNumber: 1, hasMore: true }]]),
    })
    expect(output.html).toContain('Slot Child/Published parent')
  })

  it('uses effective VC parameters for source configuration before checking an outer iteration', () => {
    const site = publishedLoopSite()
    const component = site.visualComponents[0]
    component.params.push({ id: 'pagination', name: 'Pagination', type: 'string', required: false, defaultValue: 'infinite' })
    component.tree.nodes['shared-loop'].propBindings!.pagination = { paramId: 'pagination' }
    const page = site.pages[1]
    page.nodes.root.children = ['outer']
    page.nodes.outer = makeNode({ id: 'outer', moduleId: 'base.loop', children: ['ref'] })
    page.nodes.ref.props.propOverrides = { heading: 'Heading en', pagination: 'none' }
    expect(() => assertSiteLoopScopes(site)).not.toThrow()
    page.nodes.ref.props.propOverrides = { heading: 'Heading en', pagination: 'infinite' }
    expect(() => assertSiteLoopScopes(site)).toThrow('inside another loop')
  })

  it('rejects repeated effective component instances with an actionable property path', () => {
    const site = publishedLoopSite()
    const page = site.pages[1]
    page.nodes.root.children.push('ref2')
    page.nodes.ref2 = makeNode({ id: 'ref2', moduleId: 'base.visual-component-ref', props: { componentId: 'listing' } })
    expect(() => assertPageLoopScopes(page, site)).toThrow(LoopScopeConfigurationError)
    try { assertPageLoopScopes(page, site) } catch (error) {
      expect(error).toHaveProperty('path', 'pages.page-en.nodes.shared-loop.props.pagination')
      expect(error).toHaveProperty('message', expect.stringContaining('multiple instances'))
    }
    expect(() => publishPage(page, site, registry)).toThrow(LoopScopeConfigurationError)
  })

  it('recognizes an outer loop across a filled component slot', () => {
    const site = publishedLoopSite()
    const page = site.pages[1]
    page.nodes.fill.children = ['slot-loop']
    page.nodes['slot-loop'] = makeNode({ id: 'slot-loop', moduleId: 'base.loop', props: { pagination: 'infinite' } })
    expect(() => assertSiteLoopScopes(site)).toThrow('slot-loop')
    page.nodes['slot-loop'].props.pagination = 'none'
    expect(() => assertSiteLoopScopes(site)).not.toThrow()
  })

  it.each(['page', 'entry', 'notFound'] as const)('checks the actual %s template composition', (kind) => {
    const site = publishedLoopSite()
    const terminal = site.pages[1]
    delete terminal.translationGroup
    site.pages = [terminal, site.pages[site.pages.length - 1]]
    if (kind !== 'page') terminal.template = { enabled: true, priority: 1,
      target: kind === 'entry' ? { kind: 'postTypes', tableSlugs: ['posts'] } : { kind: 'notFound' } }
    if (kind === 'entry') {
      terminal.nodes.root.children.push('entry-outlet')
      terminal.nodes['entry-outlet'] = makeNode({ id: 'entry-outlet', moduleId: 'base.outlet' })
    }
    const layout = site.pages[1]
    layout.nodes['layout-root'].children = ['layout-loop']
    layout.nodes['layout-loop'] = makeNode({ id: 'layout-loop', moduleId: 'base.loop', children: ['layout-outlet'], props: { pagination: 'none' } })
    expect(() => assertSiteLoopScopes(site)).toThrow('Infinite loop "shared-loop"')
  })

  it('ignores hidden, orphan and unused trees without resolving unrelated text properties', () => {
    const site = publishedLoopSite()
    const page = site.pages[1]
    const duplicate = makeNode({ id: 'ref2', moduleId: 'base.visual-component-ref', props: { componentId: 'listing' } })
    page.nodes.orphan = duplicate
    page.nodes.root.children.push('hidden')
    page.nodes.hidden = { ...duplicate, id: 'hidden', hidden: true }
    site.pages.push(makePage({ id: 'unused-template', template: { enabled: true, priority: -1, target: { kind: 'everywhere' } }, nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outer'] }),
      outer: makeNode({ id: 'outer', moduleId: 'base.loop', children: ['inner'] }),
      inner: makeNode({ id: 'inner', moduleId: 'base.loop', props: { pagination: 'infinite' } }),
    } }))
    site.visualComponents.push(makeVC({ id: 'unused', tree: makeVCTree('outer', [
      makeNode({ id: 'outer', moduleId: 'base.loop', children: ['inner'] }),
      makeNode({ id: 'inner', moduleId: 'base.loop', props: { pagination: 'infinite' } }),
    ]) }))
    site.visualComponents[0].tree.nodes.context.props.text = '{file.missing.url}|{site.translations.missing}'
    const before = structuredClone(site)
    expect(() => assertSiteLoopScopes(site)).not.toThrow()
    expect(site).toEqual(before)
    page.nodes.hidden.hidden = false
    expect(() => assertSiteLoopScopes(site)).toThrow('multiple instances')
  })
})
