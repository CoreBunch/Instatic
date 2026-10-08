import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { Type } from '@core/utils/typeboxHelpers'
import { registry, ModulePropsValidationError } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { collectSiteModuleAssets } from '../../../server/publish/siteModuleAssets'
import { buildPublishedEntryRenderContext } from '../../../server/publish/publishedRenderContext'
import type { PublishedDataRow } from '@core/data/schemas'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'
import { makeModule, makeRegistry } from '../publisher/helpers'

function assetsRegistry() {
  let calls = 0
  const module = makeModule('test.entry-widget', {
    schema: { count: { type: 'number', label: 'Count' } },
    propsSchema: Type.Object({ count: Type.Number({ minimum: 0 }) }),
    assets: { css: '.entry-widget{display:block}', js: 'ENTRY_WIDGET_RUNTIME' },
    render: (props) => { calls++; return { html: `<p class="entry-widget">${props.count}</p>` } },
  })
  return { registry: makeRegistry(Object.fromEntries([...registry.list(), module].map((definition) => [definition.id, definition]))), calls: () => calls }
}

describe('module assets follow native public reachability', () => {
  it('collects a localized component without resolving its page-bound props or invoking render', () => {
    const component = makeVC({ id: 'translated', name: 'Translated', tree: makeVCTree('disclosure', [
      makeNode({ id: 'disclosure', moduleId: 'base.disclosure', props: { label: '{site.translations.open}' }, children: ['turnstile'] }),
      makeNode({ id: 'turnstile', moduleId: 'base.turnstile', props: { ...registry.get('base.turnstile')!.defaults, language: '{page.language}' } }),
    ]) })
    const page = makePage({ language: 'en', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref'] }),
      ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: component.id } }),
    } })
    const site = makeSite({ pages: [page], visualComponents: [component] })
    site.settings.language = 'en'
    site.settings.localization = { catalogues: [{ language: 'en', fileId: 'english' }] }
    site.files = [{ id: 'english', name: 'English', path: 'languages/en.json', type: 'config', content: JSON.stringify({ language: 'en', messages: { open: 'Open panel' } }), createdAt: 0, updatedAt: 0 }]
    expect(collectSiteModuleAssets(site, registry).jsMap.has('base.disclosure')).toBe(true)
    expect(publishPage(page, site, registry).html).toContain('data-instatic-captcha-language="en"')
  })

  it('includes inherited params and selected slot content, excludes unused fills, hidden nodes and losing templates', () => {
    const assetDef = (id: string) => makeModule(id, { assets: { js: id + '_RUNTIME' }, render: () => { throw new Error('Asset discovery invoked render') } })
    const local = makeRegistry(Object.fromEntries([...registry.list(), assetDef('test.used'), assetDef('test.unused'), assetDef('test.hidden'), assetDef('test.loser')].map((d) => [d.id, d])))
    const inner = makeVC({ id: 'inner', name: 'Inner', params: [{ id: 'count', name: 'Count', type: 'number', defaultValue: 0, required: false }], tree: makeVCTree('used', [makeNode({ id: 'used', moduleId: 'test.used', propBindings: { count: { paramId: 'count' } } })]) })
    const outer = makeVC({ id: 'outer', name: 'Outer', params: [
      { id: 'count', name: 'Count', type: 'number', defaultValue: 0, required: false },
      { id: 'slot', name: 'Main', type: 'slot', defaultValue: '', required: false },
    ], tree: makeVCTree('outer-root', [
      makeNode({ id: 'outer-root', moduleId: 'base.container', children: ['inner-ref', 'outlet'] }),
      makeNode({ id: 'inner-ref', moduleId: 'base.visual-component-ref', props: { componentId: inner.id }, propBindings: { 'propOverrides.count': { paramId: 'count' } } }),
      makeNode({ id: 'outlet', moduleId: 'base.slot-outlet', props: { slotName: 'Main' } }),
    ]) })
    const page = makePage({ nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref', 'hidden'] }),
      ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: outer.id, propOverrides: { count: '{currentEntry.count}' } }, children: ['main-fill', 'unused-fill'] }),
      'main-fill': makeNode({ id: 'main-fill', moduleId: 'base.slot-instance', props: { slotName: 'Main' }, children: ['used'] }),
      used: makeNode({ id: 'used', moduleId: 'test.used' }),
      'unused-fill': makeNode({ id: 'unused-fill', moduleId: 'base.slot-instance', props: { slotName: 'Unused' }, children: ['unused'] }),
      unused: makeNode({ id: 'unused', moduleId: 'test.unused' }),
      hidden: { ...makeNode({ id: 'hidden', moduleId: 'test.hidden' }), hidden: true },
    } })
    const loser = makePage({ template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 }, nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['loser'] }),
      loser: makeNode({ id: 'loser', moduleId: 'test.loser' }),
    } })
    const site = makeSite({ pages: [page, loser], visualComponents: [outer, inner] })
    expect([...collectSiteModuleAssets(site, local).jsMap.keys()]).toEqual(['test.used'])
  })

  it('keeps entry props unresolved during collection and validates the actual published entry frame at render', () => {
    const { registry: local, calls } = assetsRegistry()
    const page = makePage({ template: { enabled: true, target: { kind: 'postTypes', tableSlugs: ['news'] }, priority: 0 }, nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['widget'] }),
      widget: makeNode({ id: 'widget', moduleId: 'test.entry-widget', dynamicBindings: { count: { source: 'currentEntry', field: 'count' } } }),
    } })
    const site = makeSite({ pages: [page] })
    const snapshot: PublishedPageSnapshot = { cmsSnapshotVersion: 1, pageRowId: page.id, site, runtimeAssets: { scripts: [] } }
    const row: PublishedDataRow = {
      id: 'row-version', rowId: 'actual-entry', tableId: 'news', tableSlug: 'news', tableKind: 'posts', tableRouteBase: '/news', versionNumber: 1,
      cells: { title: 'Actual entry', count: 7 }, slug: 'actual-entry', featuredMediaId: null, featuredMediaPath: null,
      authorUserId: null, authorName: null, authorRoleSlug: null, authorRoleName: null,
      publishedByUserId: null, publishedByName: null, publishedByRoleSlug: null, publishedByRoleName: null,
      publishedAt: '2026-10-08', createdAt: '2026-10-08',
    }
    expect(collectSiteModuleAssets(site, local).jsMap.get('test.entry-widget')).toBe('ENTRY_WIDGET_RUNTIME')
    expect(calls()).toBe(0)
    const resolved = buildPublishedEntryRenderContext(snapshot, row, new URL('http://localhost/news/actual-entry'))!
    const output = publishPage(resolved.page, site, local, { templateContext: resolved.templateContext })
    expect(output.html).toContain('<p class="entry-widget">7</p>')
    expect(output.jsModuleIds).toEqual(['test.entry-widget'])
    expect(calls()).toBe(1)
    row.cells.count = { invalid: true }
    const invalid = buildPublishedEntryRenderContext(snapshot, row)!
    expect(() => publishPage(invalid.page, site, local, { templateContext: invalid.templateContext })).toThrow(ModulePropsValidationError)
  })

  it('collects loop-body assets with zero rows and uses the actual iteration frame when rows render', () => {
    const { registry: local, calls } = assetsRegistry()
    const page = makePage({ nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['loop'] }),
      loop: makeNode({ id: 'loop', moduleId: 'base.loop', props: { sourceId: 'data.rows', pagination: 'none' }, children: ['widget'] }),
      widget: makeNode({ id: 'widget', moduleId: 'test.entry-widget', dynamicBindings: { count: { source: 'currentEntry', field: 'count' } } }),
    } })
    const site = makeSite({ pages: [page] })
    expect(collectSiteModuleAssets(site, local).cssMap.get('test.entry-widget')).toBe('.entry-widget{display:block}')
    expect(calls()).toBe(0)
    const empty = { items: [], totalItems: 0, pageNumber: 1, hasMore: false }
    expect(publishPage(page, site, local, { loopData: new Map([['loop', empty]]) }).jsModuleIds).toEqual([])
    const actual = { ...empty, items: [{ id: 'actual-row', fields: { count: 13 } }], totalItems: 1 }
    const output = publishPage(page, site, local, { loopData: new Map([['loop', actual]]) })
    expect(output.html).toContain('<p class="entry-widget">13</p>')
    expect(output.jsModuleIds).toEqual(['test.entry-widget'])
    expect(calls()).toBe(1)
  })
})
