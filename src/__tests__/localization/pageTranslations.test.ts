import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import { registry } from '@core/module-engine'
import { assertSiteTranslations, findDynamicNodeIds, publishPage } from '@core/publisher'
import { buildPageFrame } from '@core/templates/contextFrames'
import { composeTemplateChain, interpolateTokens, resolveDynamicProps, resolvePageTranslations } from '@core/templates'
import { duplicatePage, PageTranslationError, parsePage } from '@core/page-tree'
import { pageFromRow, pageToCells } from '@core/data/pageFromRow'
import { buildDuplicateRowCells } from '@core/data/duplicateRow'
import { DataRowSchema, DataTableSchema } from '@core/data/schemas'
import { Value } from '@core/utils/typeboxHelpers'
import { projectPageDoc, seedPageDoc } from '@core/collab'
import { validatePageWriteDiff } from '../../../server/writePolicy/pageDiff'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'

function fixture() {
  const it = makePage({ id: 'home-it', language: 'it', translationGroup: 'home', slug: 'index', title: 'Casa' })
  const en = makePage({ id: 'home-en', language: 'en', translationGroup: 'home', slug: 'en/welcome', title: 'Home & welcome' })
  const pt = makePage({ id: 'home-pt', language: 'pt-br', translationGroup: 'home', slug: 'pt/inicio', title: 'Início' })
  const site = makeSite({ pages: [it, en, pt] })
  return { site, it, en, pt }
}

describe('native page translation routes', () => {
  it('joins by authored group and canonical language, including root and the current-page attribute', () => {
    const { site, en } = fixture()
    const translations = buildPageFrame(en, site).translations!
    expect(translations.it).toEqual({ id: 'home-it', language: 'it', title: 'Casa', permalink: '/', current: false, ariaCurrent: 'false' })
    expect(translations.en).toEqual({ id: 'home-en', language: 'en', title: 'Home & welcome', permalink: '/en/welcome', current: true, ariaCurrent: 'page' })
    expect(translations['pt-BR']?.permalink).toBe('/pt/inicio')
    expect(translations.fr).toBeUndefined()
  })

  it('uses current CMS slugs after mutable or immutable edits instead of cached route maps', () => {
    const { site, en, pt } = fixture()
    expect(resolvePageTranslations(en, site)['pt-BR']?.permalink).toBe('/pt/inicio')
    pt.slug = 'pt/bem-vindo'
    expect(resolvePageTranslations(en, site)['pt-BR']?.permalink).toBe('/pt/bem-vindo')
    const changed = { ...site, pages: site.pages.map((page) => page.id === pt.id ? { ...page, slug: 'pt/nova' } : page) }
    expect(resolvePageTranslations(en, changed)['pt-BR']?.permalink).toBe('/pt/nova')
  })

  it('bakes links and attributes in shared components without scripts, holes or canonical-origin navigation', () => {
    const { site, en } = fixture()
    const component = makeVC({ id: 'language-links', tree: makeVCTree('vc-root', [
      makeNode({ id: 'vc-root', moduleId: 'base.body', children: ['link'] }),
      makeNode({ id: 'link', moduleId: 'base.link', props: { href: '{page.translations.it.permalink}', text: 'Italiano', target: '_self', htmlAttributes: { hreflang: '{page.translations.it.language}', 'aria-current': '{page.translations.it.ariaCurrent}' } } }),
    ]) })
    en.nodes.root.children = ['ref']
    en.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: component.id } })
    en.seo = { canonical: 'https://example.com/en/welcome' }
    site.visualComponents = [component]
    const html = publishPage(en, site, registry).html
    const link = new DOMParser().parseFromString(html, 'text/html').querySelector('a')!
    expect(link.getAttribute('href')).toBe('/')
    expect(link.getAttribute('hreflang')).toBe('it')
    expect(link.getAttribute('aria-current')).toBe('false')
    expect(html).toContain('href="https://example.com/en/welcome"')
    expect(html).not.toContain('{page.translations.')
    expect(html).not.toContain('<script')
    expect(findDynamicNodeIds(en, site, registry).size).toBe(0)
    expect(() => assertSiteTranslations(site)).not.toThrow()
  })

  it('resolves tokens and whole-prop bindings strictly, even with authored fallback text', () => {
    const { site, en } = fixture()
    const context = { entryStack: [], page: buildPageFrame(en, site) }
    expect(interpolateTokens('{page.translations.pt-BR.permalink}', context)).toBe('/pt/inicio')
    expect(resolveDynamicProps({ href: '#' }, { href: { source: 'page', field: 'translations.it.permalink' } }, context).href).toBe('/')
    expect(() => interpolateTokens('{page.translations.fr.permalink|/}', context)).toThrow(PageTranslationError)
    expect(() => resolveDynamicProps({ href: '/' }, { href: { source: 'page', field: 'translations.fr.permalink', fallback: 'static' } }, context)).toThrow(PageTranslationError)
    expect(() => interpolateTokens('{page.translations.en.unknown}', context)).toThrow(PageTranslationError)
    for (const field of ['constructor.name', '__proto__.constructor', 'toString.name']) {
      expect(() => interpolateTokens(`{page.translations.${field}|/}`, context)).toThrow(PageTranslationError)
      expect(() => resolveDynamicProps({ href: '/' }, { href: { source: 'page', field: `translations.${field}` } }, context)).toThrow(PageTranslationError)
    }
  })

  it('rejects duplicate canonical languages, missing explicit languages and template membership', () => {
    const { site, en, pt } = fixture()
    pt.language = 'EN'
    expect(() => assertSiteTranslations(site)).toThrow('more than one page')
    pt.language = 'pt-BR'
    delete en.language
    expect(() => assertSiteTranslations(site)).toThrow('explicitly')
    en.language = 'en'
    en.template = { enabled: true, target: { kind: 'everywhere' }, priority: 0 }
    expect(() => assertSiteTranslations(site)).toThrow('ordinary pages')
  })

  it('preflights reachable VC defaults, bindings, attributes and template chrome before publishing', () => {
    const { site, en } = fixture()
    const component = makeVC({ id: 'header', tree: makeVCTree('vc-root', [
      makeNode({ id: 'vc-root', moduleId: 'base.body', children: ['link'] }),
      makeNode({ id: 'link', moduleId: 'base.link', props: { href: '{page.translations.fr.permalink}' } }),
    ]) })
    en.nodes.root.children = ['ref']
    en.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: component.id } })
    site.visualComponents = [component]
    expect(() => assertSiteTranslations(site)).toThrow('page.translations.fr.permalink')
    component.tree.nodes.link.props.href = '/'
    component.tree.nodes.link.propBindings = { href: { paramId: 'href' } }
    component.params = [{ id: 'href', name: 'URL', type: 'string', required: true, defaultValue: '{page.translations.fr.permalink}' }]
    expect(() => assertSiteTranslations(site)).toThrow(PageTranslationError)
    component.params = []
    component.tree.nodes.link.props.htmlAttributes = { title: '{page.translations.fr.title}' }
    expect(() => assertSiteTranslations(site)).toThrow(PageTranslationError)
    site.visualComponents = []
    en.nodes.root.children = []
    const template = makePage({ id: 'chrome', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['link', 'outlet'] }),
      link: makeNode({ id: 'link', moduleId: 'base.link', props: { href: '{page.translations.fr.permalink}' } }),
      outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet' }),
    }, template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 } })
    site.pages.push(template)
    expect(() => assertSiteTranslations(site)).toThrow(PageTranslationError)
  })

  it('does not require unused component route bindings, or unrelated languages for ungrouped pages', () => {
    const { site } = fixture()
    site.visualComponents = [makeVC({ params: [{ id: 'url', name: 'URL', type: 'string', required: false, defaultValue: '{page.translations.fr.permalink}' }] })]
    site.pages.push(makePage({ id: 'standalone', slug: 'single' }))
    expect(() => assertSiteTranslations(site)).not.toThrow()
    expect(buildPageFrame(site.pages[3]!, site).translations).toEqual({})
  })

  it('checks rendered subtrees and ignores hidden, orphaned or unused component values', () => {
    const { site, en } = fixture()
    const missing = makeNode({ id: 'missing', moduleId: 'base.link', props: { href: '{page.translations.fr.permalink}' } })
    const component = makeVC({ id: 'header', tree: makeVCTree('vc-root', [
      makeNode({ id: 'vc-root', moduleId: 'base.body' }),
      missing,
    ]) })
    site.visualComponents = [component]
    component.params = [{ id: 'unused', name: 'Unused URL', type: 'url', required: false, defaultValue: '{page.translations.fr.permalink}' }]
    en.nodes.root.children = ['ref', 'hidden']
    en.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: component.id, propOverrides: { unused: '{page.translations.fr.permalink}' } } })
    en.nodes.hidden = makeNode({ id: 'hidden', moduleId: 'base.container', hidden: true, children: ['missing'] })
    en.nodes.missing = missing
    expect(() => assertSiteTranslations(site)).not.toThrow()
    component.tree.nodes['vc-root']!.children = ['missing']
    component.tree.nodes.missing!.hidden = true
    expect(() => assertSiteTranslations(site)).not.toThrow()
    component.tree.nodes.missing!.hidden = false
    expect(() => assertSiteTranslations(site)).toThrow(PageTranslationError)
  })

  it('preflights page-route bindings in SEO attributes and nested structured data', () => {
    const { site, en } = fixture()
    en.seo = { meta: [{ attribute: 'property', key: 'og:url', content: '{page.translations.fr.permalink}' }] }
    expect(() => assertSiteTranslations(site)).toThrow(PageTranslationError)
    en.seo = { structuredData: [{ '@type': 'WebPage', alternate: { url: '{page.translations.fr.permalink}' } }] }
    expect(() => assertSiteTranslations(site)).toThrow(PageTranslationError)
    en.seo.structuredData![0]!.alternate = { url: '{page.translations.it.permalink}' }
    expect(() => assertSiteTranslations(site)).not.toThrow()
  })

  it('retains terminal translation identity across template composition', () => {
    const { site, en } = fixture()
    const template = makePage({ id: 'layout', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outlet'] }),
      outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet' }),
    } })
    const merged = composeTemplateChain([template], { kind: 'page', page: en })
    expect(merged.translationGroup).toBe('home')
    expect(buildPageFrame(merged, site).translations?.en?.ariaCurrent).toBe('page')
  })

  it('keeps the roster authoritative over a stale caller-provided route frame', () => {
    const { site, en } = fixture()
    en.nodes.root.children = ['link']
    en.nodes.link = makeNode({ id: 'link', moduleId: 'base.link', props: { href: '{page.translations.it.permalink}', text: 'IT' } })
    const pageFrame = buildPageFrame(en, site)
    pageFrame.translations!.it!.permalink = '/stale'
    const html = publishPage(en, site, registry, { templateContext: { entryStack: [], page: pageFrame } }).html
    expect(html).toContain('href="/"')
    expect(html).not.toContain('/stale')
  })
})

describe('translation relationship storage', () => {
  it('round-trips cells, parsing and co-editing, with a new copy deliberately unassociated', () => {
    const { site, en } = fixture()
    const row = { ...Value.Create(DataRowSchema), id: en.id, tableId: 'pages', slug: en.slug, cells: pageToCells(en) }
    expect(pageFromRow(row).translationGroup).toBe('home')
    expect(parsePage(en, 0).translationGroup).toBe('home')
    const doc = new Y.Doc()
    seedPageDoc(doc, en)
    expect(projectPageDoc(doc, en.id).translationGroup).toBe('home')
    const copy = duplicatePage(site, en.id, 'Copy')
    expect(copy.language).toBe('en')
    expect(copy.translationGroup).toBeUndefined()
    expect(buildDuplicateRowCells(Value.Create(DataTableSchema), row, []).translationGroup).toBeUndefined()
    expect(() => parsePage({ ...en, translationGroup: 'invalid / group' }, 0)).toThrow(PageTranslationError)
    expect(() => pageFromRow({ ...row, cells: { ...row.cells, translationGroup: {} } })).toThrow(PageTranslationError)
  })

  it('does not alter a custom table cell with the same field name when duplicating', () => {
    const row = { ...Value.Create(DataRowSchema), tableId: 'custom', cells: { translationGroup: 'authored-custom-value' } }
    expect(buildDuplicateRowCells(Value.Create(DataTableSchema), row, []).translationGroup).toBe('authored-custom-value')
  })

  it('requires structural capability to change the translation relationship', () => {
    const { en } = fixture()
    const input = { previousPages: [en], changedPages: [{ ...en, translationGroup: 'other' }], deletedPageIds: new Set<string>() }
    expect(() => validatePageWriteDiff({ ...input, capabilities: ['site.content.edit'] })).toThrow('translationGroup')
    expect(() => validatePageWriteDiff({ ...input, capabilities: ['site.structure.edit'] })).not.toThrow()
  })
})
