import { beforeEach, describe, expect, it } from 'bun:test'
import type { Page, SiteDocument, StyleRule } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { collectClassCSS, collectUsedStyleRuleIds, publishPage, type RenderResolvedMedia } from '@core/publisher'
import { DEFAULT_SCRIPT_RUNTIME_CONFIG, type PublishedPageRuntimeAssets } from '@core/site-runtime'
import { buildSiteCssBundle, buildPublishedSiteCssBundle } from '../../../server/publish/siteCssBundle'
import { buildSiteRuntimeScripts } from '../../../server/publish/runtime/bundleScripts'
import { bumpPublishVersion, resetPublishStateForTests } from '../../../server/publish/publishState'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'

function rule(id: string, selector = `.${id}`, kind: StyleRule['kind'] = 'class'): StyleRule {
  return { id, name: id, kind, selector, order: 0, styles: { color: 'green' }, contextStyles: {}, createdAt: 0, updatedAt: 0 }
}
function page(id: string, classIds: string[]): Page {
  return { ...makePage({ root: { moduleId: 'base.text', props: {}, classIds } }), id, slug: id }
}
function component(id: string, nodes: Page['nodes'], classIds: string[] = []): VisualComponent {
  return { id, name: id, tree: { rootNodeId: 'root', nodes }, params: [], classIds, createdAt: 0 }
}
function script(id: string, content: string): SiteDocument['files'][number] {
  return { id, path: `src/scripts/${id}.js`, type: 'script', content, createdAt: 0, updatedAt: 0 }
}
function manifest(fileId: string, src = '/_instatic/assets/script.js'): PublishedPageRuntimeAssets {
  return { scripts: [{ fileId, src, format: 'module', placement: 'body-end', timing: 'dom-ready', priority: 100 }] }
}
const textRegistry = makeRegistry({ 'base.text': makeModule('base.text', { render: () => ({ html: '<p>Text</p>' }) }) })

describe('page-scoped registry CSS', () => {
  beforeEach(resetPublishStateForTests)

  it('separates disjoint pages and excludes orphan/hidden subtrees while preserving editor-wide usage', () => {
    const a = page('a', ['alpha'])
    const b = page('b', ['beta'])
    a.nodes.orphan = { ...a.nodes.root, id: 'orphan', classIds: ['orphan'] }
    a.nodes.hidden = { ...a.nodes.root, id: 'hidden', hidden: true, classIds: ['hidden'], children: ['child'] }
    a.nodes.child = { ...a.nodes.root, id: 'child', classIds: ['hidden-child'] }
    a.nodes.root.children = ['hidden']
    const site = makeSite({ pages: [a, b], styleRules: Object.fromEntries(['alpha', 'beta', 'orphan', 'hidden', 'hidden-child'].map((id) => [id, rule(id)])) })
    expect(collectClassCSS(site, a)).toContain('.alpha {')
    for (const id of ['beta', 'orphan', 'hidden', 'hidden-child']) expect(collectClassCSS(site, a)).not.toContain(`.${id} {`)
    expect(collectClassCSS(site, b)).toContain('.beta {')
    expect(collectClassCSS(site, b)).not.toContain('.alpha {')
    expect([...collectUsedStyleRuleIds(site)].sort()).toEqual(['alpha', 'beta', 'hidden', 'hidden-child', 'orphan'])
  })

  it('materializes nested VC refs, instance classes, slot fills and defaults without unused definitions', () => {
    const nested = component('nested', makePage({ root: { moduleId: 'base.text', classIds: ['nested-node'] } }).nodes, ['nested-component'])
    const outerTree = makePage({
      root: { moduleId: 'base.container', classIds: ['outer-node'], children: ['nested-ref', 'slot'] },
      'nested-ref': { moduleId: 'base.visual-component-ref', props: { componentId: 'nested' }, classIds: ['nested-ref'] },
      slot: { moduleId: 'base.slot-outlet', props: { slotName: 'content' } },
      orphan: { moduleId: 'base.text', classIds: ['vc-orphan'] },
    })
    const outer = component('outer', outerTree.nodes, ['outer-component'])
    outer.params = [{ id: 'content-param', name: 'content', type: 'slot', required: false, defaultValue: [{ ...outerTree.nodes.orphan, id: 'default', classIds: ['slot-default'] }] }]
    const unused = component('unused', makePage({ root: { moduleId: 'base.text', classIds: ['unused-component'] } }).nodes)
    const consumer = makePage({
      root: { moduleId: 'base.visual-component-ref', props: { componentId: 'outer' }, classIds: ['instance'], children: ['slot-fill'] },
      'slot-fill': { moduleId: 'base.slot-instance', props: { slotName: 'content' }, children: ['content'] },
      content: { moduleId: 'base.text', classIds: ['slot-content'] },
    })
    const names = ['instance', 'outer-node', 'outer-component', 'nested-ref', 'nested-node', 'nested-component', 'slot-default', 'slot-content', 'vc-orphan', 'unused-component']
    const site = makeSite({ pages: [consumer], visualComponents: [outer, nested, unused], styleRules: Object.fromEntries(names.map((id) => [id, rule(id)])) })
    const filled = collectClassCSS(site, consumer)
    for (const id of names.slice(0, 6).concat('slot-content')) expect(filled).toContain(`.${id} {`)
    for (const id of ['slot-default', 'vc-orphan', 'unused-component']) expect(filled).not.toContain(`.${id} {`)
    const noFill = structuredClone(consumer)
    noFill.nodes.root.children = []
    const defaults = collectClassCSS(site, noFill)
    expect(defaults).toContain('.slot-default {')
    expect(defaults).not.toContain('.slot-content {')
    // Each reference is a separate instance. A global visited-component set
    // would drop the second instance's different fill.
    const twoInstances = structuredClone(consumer)
    twoInstances.nodes.first = { ...twoInstances.nodes.root, id: 'first' }
    twoInstances.nodes.root = { ...twoInstances.nodes.root, props: {}, moduleId: 'base.container', children: ['first', 'second'] }
    twoInstances.nodes.second = { ...twoInstances.nodes.first, id: 'second', children: ['second-slot'] }
    twoInstances.nodes['second-slot'] = { ...twoInstances.nodes['slot-fill'], id: 'second-slot', children: ['second-content'] }
    twoInstances.nodes['second-content'] = { ...twoInstances.nodes.content, id: 'second-content', classIds: ['second-content'] }
    site.styleRules!['second-content'] = rule('second-content')
    const twice = collectClassCSS(site, twoInstances)
    expect(twice).toContain('.slot-content {')
    expect(twice).toContain('.second-content {')
  })

  it('guards nested component cycles', () => {
    const a = component('a', makePage({ root: { moduleId: 'base.visual-component-ref', props: { componentId: 'b' }, classIds: ['a'] } }).nodes)
    const b = component('b', makePage({ root: { moduleId: 'base.visual-component-ref', props: { componentId: 'a' }, classIds: ['b'] } }).nodes)
    const consumer = makePage({ root: { moduleId: 'base.visual-component-ref', props: { componentId: 'a' } } })
    const site = makeSite({ pages: [consumer], visualComponents: [a, b], styleRules: { a: rule('a'), b: rule('b') } })
    expect(collectClassCSS(site, consumer)).toContain('.a {')
    expect(collectClassCSS(site, consumer)).toContain('.b {')
  })

  it('keeps negative/alternative functional selectors and conservative raw/class-free ambient rules', () => {
    const current = page('a', ['card'])
    const rules = {
      card: rule('card', '.card:not(.closed):is(.a, .b)'), closed: rule('closed'), a: rule('a'), b: rule('b'),
      alternative: rule('alternative', ':is(.a, .b) .card', 'ambient'),
      unrelated: rule('unrelated', '.closed .card', 'ambient'),
      body: rule('body', 'body', 'ambient'),
      raw: { ...rule('raw', '', 'ambient'), rawCss: '@keyframes pulse { to { opacity: 0; } }' },
    }
    const css = collectClassCSS(makeSite({ pages: [current], styleRules: rules }), current)
    expect(css).toContain('.card:not(.closed):is(.a, .b)')
    expect(css).toContain(':is(.a, .b) .card')
    expect(css).not.toContain('.closed .card')
    expect(css).toContain('body {')
    expect(css).toContain('@keyframes pulse')
  })

  it('uses only scripts actually emitted for the page, including imported helpers and import cycles', async () => {
    const a = page('a', [])
    const b = page('b', [])
    const files = [
      script('global', "document.body.classList.add('global-state')"),
      script('scoped', "import './helper.js'; document.body.classList.add('a-state')"),
      script('helper', "import './scoped.js'; document.body.classList.add('helper-state')"),
      script('disabled', "document.body.classList.add('disabled-state')"),
      script('other', "document.body.classList.add('b-state')"),
    ]
    const site = makeSite({ pages: [a, b], files, styleRules: Object.fromEntries(['global-state', 'a-state', 'helper-state', 'disabled-state', 'b-state'].map((id) => [id, rule(id)])) })
    site.runtime = { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, styles: {}, scripts: {
      scoped: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: ['a'] } },
      helper: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, enabled: false },
      disabled: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, enabled: false },
      other: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: ['b'] } },
    } }
    for (const current of [a, b]) {
      const built = await buildSiteRuntimeScripts({ site, page: current, target: 'publish', assetBasePath: '/_instatic/assets/test/' })
      expect(built.diagnostics).toEqual([])
      const css = collectClassCSS(site, current, { runtimeAssets: built.runtimeAssets })
      expect(css).toContain('.global-state {')
      if (current === a) {
        expect(css).toContain('.a-state {')
        expect(css).toContain('.helper-state {')
        expect(css).not.toContain('.b-state {')
      } else {
        expect(css).toContain('.b-state {')
        expect(css).not.toContain('.a-state {')
        expect(css).not.toContain('.helper-state {')
      }
      expect(css).not.toContain('.disabled-state {')
    }
    expect(collectClassCSS(site, a)).toBe('')
  })

  it('rejects script URLs the HTML emitter would not emit and keeps actual manifest scope through composition', () => {
    const current = page('composed-template', [])
    const site = makeSite({ pages: [current], files: [script('source', "document.body.classList.add('open')")], styleRules: { open: rule('open') } })
    site.runtime = { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, styles: {}, scripts: {
      source: { ...DEFAULT_SCRIPT_RUNTIME_CONFIG, scope: { type: 'pages', pageIds: ['original-page'] } },
    } }
    expect(collectClassCSS(site, current, { runtimeAssets: manifest('source') })).toContain('.open {')
    for (const src of ['https://external.test/file.js', '//external.test/file.js', '/assets/../file.js']) {
      expect(collectClassCSS(site, current, { runtimeAssets: manifest('source', src) })).toBe('')
    }
  })

  it('emits identical class CSS inline and externally for each effective page and emitted script', () => {
    const a = page('a', ['alpha'])
    const b = page('b', ['beta'])
    const site = makeSite({ pages: [a, b], files: [script('state', "document.body.classList.add('open')")], styleRules: { alpha: rule('alpha'), beta: rule('beta'), open: rule('open') } })
    const runtimeAssets = manifest('state')
    for (const current of [a, b]) {
      const bundle = buildSiteCssBundle(site, textRegistry, current, { runtimeAssets })
      const inline = publishPage(current, site, textRegistry, { runtimeAssets }).html
      const external = publishPage(current, site, textRegistry, { runtimeAssets, cssEmission: 'external', cssBundle: bundle }).html
      expect(inline).toContain(bundle.style.content)
      expect(external).toContain(`/_instatic/css/${bundle.style.filename}`)
      expect(bundle.style.content).toContain('.open {')
      expect(bundle.style.content).not.toContain(current === a ? '.beta {' : '.alpha {')
    }
  })

  it('never shares authored CSS between pages, media variants or publish versions', () => {
    const a = page('a', ['alpha'])
    const b = page('b', ['beta'])
    const site = makeSite({ pages: [a, b], styleRules: { alpha: { ...rule('alpha'), styles: { backgroundImage: 'url("/uploads/hero.png")' } }, beta: rule('beta') } })
    const media = (path: string): ReadonlyMap<string, RenderResolvedMedia> => new Map([['/uploads/hero.png', {
      publicPath: '/uploads/hero.png', mimeType: 'image/png', width: 2048, height: 1024, altText: '', blurHash: null, posterPath: null,
      variants: [{ width: 1024, height: 512, path, sizeBytes: 1, format: 'webp' }],
    }]])
    const first = buildPublishedSiteCssBundle(site, textRegistry, a, undefined, { mediaAssets: media('/uploads/a.webp') })
    const second = buildPublishedSiteCssBundle(site, textRegistry, b, undefined, { mediaAssets: media('/uploads/b.webp') })
    const changed = buildPublishedSiteCssBundle(site, textRegistry, a, undefined, { mediaAssets: media('/uploads/b.webp') })
    expect(second.framework).toBe(first.framework)
    expect(second.style.content).toContain('.beta {')
    expect(second.style.content).not.toContain('.alpha {')
    expect(first.style.content).toContain('/uploads/a.webp')
    expect(changed.style.content).toContain('/uploads/b.webp')
    expect(changed.style.hash).not.toBe(first.style.hash)
    site.styleRules!.alpha.styles = { color: 'red' }
    bumpPublishVersion()
    const published = buildPublishedSiteCssBundle(site, textRegistry, a)
    expect(published.framework).not.toBe(first.framework)
    expect(published.style.content).toContain('color: red')
    expect(published.style.content).not.toContain('/uploads/a.webp')
  })
})
