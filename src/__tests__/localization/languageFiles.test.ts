import { describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import '@modules/base'
import { registry } from '@core/module-engine'
import { assertSiteTranslations, findDynamicNodeIds, publishPage } from '@core/publisher'
import { canonicalLanguage, LocalizationError, resolveSiteLanguage } from '@core/localization'
import { buildPageFrame, buildSiteFrame } from '@core/templates/contextFrames'
import { interpolateTokens } from '@core/templates/tokenInterpolation'
import { resolveDynamicProps } from '@core/templates/dynamicBindings'
import { composeTemplateChain } from '@core/templates'
import { pageFromRow, pageToCells } from '@core/data/pageFromRow'
import { DataRowSchema } from '@core/data/schemas'
import { Value } from '@core/utils/typeboxHelpers'
import { seedPageDoc, projectPageDoc, seedSiteDoc, projectSiteDoc } from '@core/collab'
import { validatePages, validateSite } from '@core/persistence/validate'
import { duplicatePage } from '@core/page-tree'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'

export function languageFixture() {
  const files = ['it', 'en'].map((language) => ({
    id: language, path: `locales/${language}.json`, type: 'config' as const,
    content: JSON.stringify({ language, messages: { header: { contact: language === 'it' ? 'Contatti' : 'Contact & support' } } }),
    createdAt: 0, updatedAt: 0,
  }))
  const page = makePage({ language: 'en', nodes: {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref'], props: { htmlAttributes: { 'data-language': '{site.language}' } } }),
    ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'header' } }),
  } })
  const component = makeVC({ id: 'header', name: 'Header', tree: makeVCTree('vc-body', [
    makeNode({ id: 'vc-body', moduleId: 'base.body', children: ['label'] }),
    makeNode({ id: 'label', moduleId: 'base.text', props: { text: '{site.translations.header.contact}', tag: 'h2', htmlAttributes: { title: '{site.translations.header.contact}' } } }),
  ]) })
  const site = makeSite({ files, pages: [page], visualComponents: [component], settings: {
    shortcuts: {}, language: 'it', localization: { catalogues: files.map((file) => ({ language: file.id, fileId: file.id })) },
    metaTitle: '{site.translations.header.contact}', metaDescription: '{site.translations.header.contact}',
  } })
  return { site, page, component }
}

describe('language-file static rendering', () => {
  it('renders one reusable native component in two languages without translation runtime or dictionary downloads', () => {
    const { site, page, component } = languageFixture()
    const before = structuredClone(component)
    const english = publishPage(page, site, registry).html
    const italian = publishPage({ ...page, language: 'it' }, site, registry).html
    expect(english).toContain('<html lang="en">')
    expect(english).toContain('<body data-language="en">')
    expect(english).toContain('<h2 title="Contact &amp; support">Contact &amp; support</h2>')
    expect(english).toContain('<title>Contact &amp; support</title>')
    expect(english).toContain('content="Contact &amp; support"')
    expect(italian).toContain('<html lang="it">')
    expect(italian).toContain('<h2 title="Contatti">Contatti</h2>')
    expect(english).not.toContain('locales/')
    expect(english).not.toContain('{site.translations')
    expect(english).not.toContain('<script')
    expect(component).toEqual(before)
    expect(findDynamicNodeIds(page, site, registry).size).toBe(0)
  })

  it('uses the same frame for canvas props and publication, including native VC params', () => {
    const { site, page, component } = languageFixture()
    const frame = buildSiteFrame(site, page.language)
    const canvas = resolveDynamicProps(component.tree.nodes.label.props, undefined, { entryStack: [], site: frame })
    expect(canvas.text).toBe('Contact & support')
    component.params = [{ id: 'label-param', name: 'Label', type: 'string', required: true, defaultValue: '{site.translations.header.contact}' }]
    component.tree.nodes.label.props.text = ''
    component.tree.nodes.label.propBindings = { text: { paramId: 'label-param' } }
    expect(publishPage(page, site, registry).html).toContain('Contact &amp; support</h2>')
    expect(buildPageFrame(page, site).language).toBe('en')
  })

  it('keeps terminal page language inside an outer template and preserves language on duplication', () => {
    const { site, page } = languageFixture()
    const template = makePage({ id: 'layout', language: 'it', nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['outlet'] }),
      outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet' }),
    }, template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 } })
    const merged = composeTemplateChain([template], { kind: 'page', page })
    expect(merged.language).toBe('en')
    expect(publishPage(merged, site, registry).html).toContain('<html lang="en">')
    expect(duplicatePage(site, page.id, 'Copy').language).toBe('en')
  })

  it('observes immutable native file edits without stale cached translations', () => {
    const { site } = languageFixture()
    expect(resolveSiteLanguage(site, 'en').translations?.header).toEqual({ contact: 'Contact & support' })
    const changed = { ...site, files: site.files.map((file) => file.id === 'en' ? { ...file, content: JSON.stringify({ language: 'en', messages: { header: { contact: 'Speak to us' } } }) } : file) }
    expect(resolveSiteLanguage(changed, 'en').translations?.header).toEqual({ contact: 'Speak to us' })
  })

  it('keeps language files authoritative even when a caller supplies a different cached site frame', () => {
    const { site, page } = languageFixture()
    const html = publishPage(page, site, registry, { templateContext: {
      entryStack: [], site: { id: site.id, name: site.name, language: 'it', translations: { header: { contact: 'Stale copied text' } } },
    } }).html
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('Contact &amp; support</h2>')
    expect(html).not.toContain('Stale copied text')
  })
})

describe('language catalogue validation', () => {
  it('preflights shared defaults, instance params, attributes, structured bindings and SEO using native token syntax', () => {
    const { site, page, component } = languageFixture()
    expect(() => assertSiteTranslations(site)).not.toThrow()
    component.params = [{ id: 'param', name: 'Text', type: 'string', required: true, defaultValue: '{site.translations.header.missing}' }]
    expect(() => assertSiteTranslations(site)).toThrow('translations.header.missing')
    component.params = []
    page.nodes.ref.props.propOverrides = { Text: '{site.translations.header.missing}' }
    expect(() => assertSiteTranslations(site)).toThrow('translations.header.missing')
    delete page.nodes.ref.props.propOverrides
    page.nodes.root.props.htmlAttributes = { title: '{site.translations.header.missing}' }
    expect(() => assertSiteTranslations(site)).toThrow('translations.header.missing')
    page.nodes.root.props.htmlAttributes = {}
    page.nodes.root.dynamicBindings = { title: { source: 'site', field: 'translations.header.missing' } }
    expect(() => assertSiteTranslations(site)).toThrow('translations.header.missing')
    delete page.nodes.root.dynamicBindings
    site.settings.metaTitle = '{site.translations.header.missing}'
    expect(() => assertSiteTranslations(site)).toThrow('translations.header.missing')
    site.settings.metaTitle = '\\{site.translations.header.missing}'
    expect(() => assertSiteTranslations(site)).not.toThrow()
  })

  it('rejects missing keys even when a token or structured binding asks for fallback text', () => {
    const { site } = languageFixture()
    const context = { entryStack: [], site: buildSiteFrame(site, 'en') }
    expect(() => interpolateTokens('{site.translations.header.missing|Fallback}', context)).toThrow(LocalizationError)
    expect(() => resolveDynamicProps({ text: 'Fallback' }, { text: { source: 'site', field: 'translations.header.missing', fallback: 'static' } }, context)).toThrow(LocalizationError)
  })

  for (const [name, content] of Object.entries({
    malformed: '{',
    array: JSON.stringify({ language: 'en', messages: { header: [] } }),
    number: JSON.stringify({ language: 'en', messages: { header: { contact: 3 } } }),
    extraProperty: JSON.stringify({ language: 'en', messages: { header: { contact: 'Text' } }, extra: true }),
    reserved: '{"language":"en","messages":{"header":{"constructor":"Text"}}}',
    empty: JSON.stringify({ language: 'en', messages: { header: { contact: ' ' } } }),
    wrongLanguage: JSON.stringify({ language: 'fr', messages: { header: { contact: 'Text' } } }),
    missingKey: JSON.stringify({ language: 'en', messages: { header: { different: 'Text' } } }),
  })) {
    it(`blocks publication for ${name} language data`, () => {
      const { site, page } = languageFixture()
      site.files = site.files.map((file) => file.id === 'en' ? { ...file, content } : file)
      expect(() => publishPage(page, site, registry)).toThrow(LocalizationError)
    })
  }

  it('rejects unconfigured and duplicate language tags, and accepts canonical BCP-47 tags', () => {
    const { site } = languageFixture()
    expect(() => resolveSiteLanguage(site, 'fr')).toThrow('No language catalogue')
    site.settings.localization!.catalogues.push({ language: 'EN', fileId: 'en' })
    expect(() => resolveSiteLanguage(site, 'en')).toThrow('Duplicate language')
    expect(canonicalLanguage('pt-br')).toBe('pt-BR')
    expect(() => canonicalLanguage('en_US')).toThrow(LocalizationError)
  })

  it('preserves unconfigured sites, including escaped document language values', () => {
    const site = makeSite({ settings: { shortcuts: {}, language: 'en" unsafe' } })
    const page = makePage()
    expect(publishPage(page, site, registry).html).toContain('lang="en&quot; unsafe"')
    expect(resolveSiteLanguage(site).translations).toBeUndefined()
  })

  it('escapes plain translation text at publication rather than inserting translated HTML', () => {
    const { site, page } = languageFixture()
    site.files = site.files.map((file) => ({ ...file, content: JSON.stringify({ language: file.id, messages: { header: { contact: '<script>alert(1)</script>' } } }) }))
    const html = publishPage(page, site, registry).html
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})

describe('language native storage and co-editing', () => {
  it('round-trips explicit language through page cells and collaboration metadata', () => {
    const { page, site } = languageFixture()
    const row = { ...Value.Create(DataRowSchema), id: page.id, tableId: 'pages', slug: page.slug, cells: pageToCells(page) }
    expect(pageFromRow(row).language).toBe('en')
    const doc = new Y.Doc()
    seedPageDoc(doc, page)
    expect(projectPageDoc(doc, page.id).language).toBe('en')
    const shell = new Y.Doc()
    seedSiteDoc(shell, site)
    const projected = projectSiteDoc(shell)
    expect(projected.shell.settings).toEqual(site.settings)
    expect(validatePages(validateSite(site), site.pages, site.visualComponents)[0].language).toBe('en')
  })
})
