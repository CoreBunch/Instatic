import { describe, expect, it } from 'bun:test'
import type { Page, SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { assertPagePublicFileBindings, assertSitePublicFileBindings, publishPage } from '@core/publisher'
import { PublicAssetValidationError } from '@core/files/publicAssets'
import { makePage, makeSite, makeModule, makeRegistry } from './helpers'

function fixture() {
  const page = makePage({ root: { moduleId: 'base.body', children: ['image'] }, image: { moduleId: 'base.image', props: { src: '{file.manifest.url}' } } })
  const site = makeSite({ pages: [page], files: [{ id: 'manifest', type: 'asset', path: 'public/manifest.webmanifest',
    blob: { mimeType: 'application/manifest+json', base64: 'e30=' }, createdAt: 1, updatedAt: 1 }] })
  return { page, site }
}
function component(): VisualComponent {
  return { id: 'card', name: 'Card', createdAt: 1, classIds: [], breakpoints: [],
    tree: { rootNodeId: 'card-root', nodes: makePage({
      'card-root': { moduleId: 'base.container', children: ['card-image', 'slot'] },
      'card-image': { moduleId: 'base.image', propBindings: { src: { paramId: 'src-param' } } },
      slot: { moduleId: 'base.slot-outlet', props: { slotName: 'children' } },
    }, 'card-root').nodes },
    params: [
      { id: 'src-param', name: 'src', type: 'string', required: false, defaultValue: '{file.missing-default.url}' },
      { id: 'slot-param', name: 'children', type: 'slot', required: false,
        defaultValue: Object.values(makePage({ 'default-image': { moduleId: 'base.image', props: { src: '{file.missing-slot.url}' } } }, 'default-image').nodes) },
    ],
  }
}

describe('native public-file binding preflight', () => {
  it.each([
    ['string prop', (page: Page) => { page.nodes.image!.props.src = '{file.missing.url|placeholder}' }],
    ['structured binding', (page: Page) => { page.nodes.image!.dynamicBindings = { src: { source: 'file', field: 'missing.url', fallback: 'static' } } }],
    ['root attributes', (page: Page) => { page.nodes.root!.props.htmlAttributes = { 'data-asset': '{file.missing.url}' } }],
    ['SEO link', (page: Page) => { page.seo = { links: [{ id: 'manifest', rel: 'manifest', href: '{file.missing.url}' }] } }],
    ['JSON-LD value', (page: Page) => { page.seo = { structuredData: [{ image: [{ url: '{file.missing.url}' }] }] } }],
    ['site metadata', (_page: Page, site: SiteDocument) => { site.settings.metaTitle = '{file.missing.path}' }],
    ['favicon', (_page: Page, site: SiteDocument) => { site.settings.faviconUrl = '{file.missing.url}' }],
  ] as const)('fails explicitly for a missing file in %s', (_name, change) => {
    const { page, site } = fixture()
    change(page, site)
    expect(() => assertSitePublicFileBindings(site)).toThrow(PublicAssetValidationError)
  })

  it('validates only effective overrides/filled slots, preserving their native structured bindings', () => {
    const { site } = fixture()
    const page = makePage({
      root: { moduleId: 'base.visual-component-ref', props: { componentId: 'card', propOverrides: { 'src-param': '{file.manifest.url}', unused: '{file.missing-override.url}' } }, children: ['fill-slot'] },
      'fill-slot': { moduleId: 'base.slot-instance', props: { slotName: 'children' }, children: ['fill-image'] },
      'fill-image': { moduleId: 'base.image', dynamicBindings: { src: { source: 'file', field: 'manifest.url' } } },
    })
    site.pages = [page]
    site.visualComponents = [component()]
    expect(() => assertSitePublicFileBindings(site)).not.toThrow()
    page.nodes['fill-image']!.dynamicBindings!.src!.field = 'missing-fill.url'
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing-fill.url')
    page.nodes['fill-image']!.dynamicBindings!.src!.field = 'manifest.url'
    page.nodes.root!.children = []
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing-slot.url')
  })

  it('omits hidden/orphan/unreferenced content and overridden head defaults', () => {
    const { page, site } = fixture()
    page.nodes.image!.hidden = true
    page.nodes.orphan = { ...page.nodes.image!, id: 'orphan', hidden: false, props: { src: '{file.missing.url}' } }
    page.nodes.image!.props.src = '{file.missing.url}'
    page.seo = { title: 'Authored title', description: 'Authored description', links: [{ id: 'icon', rel: 'icon', href: '/existing-icon.png' }] }
    site.settings.metaTitle = '{file.missing.url}'
    site.settings.metaDescription = '{file.missing.url}'
    site.settings.faviconUrl = '{file.missing.url}'
    site.visualComponents = [component()]
    expect(() => assertSitePublicFileBindings(site)).not.toThrow()
    page.nodes.image!.hidden = false
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing.url')
  })

  it('uses the emitted prop after a structured binding replaces a static file token', () => {
    const { page, site } = fixture()
    page.nodes.image!.props.src = '{file.missing.url}'
    page.nodes.image!.dynamicBindings = { src: { source: 'page', field: 'permalink' } }
    expect(() => assertPagePublicFileBindings(page, site)).not.toThrow()
  })

  it('checks effective scalar params through nested component references', () => {
    const { page, site } = fixture()
    const outer = component()
    outer.tree.nodes['card-image'] = { ...outer.tree.nodes['card-image']!, moduleId: 'base.visual-component-ref',
      propBindings: {}, props: { componentId: 'inner', propOverrides: { 'inner-src': '{file.manifest.url}' } } }
    outer.tree.nodes['card-root']!.children = ['card-image']
    const inner: VisualComponent = { ...component(), id: 'inner', name: 'Inner',
      params: [{ id: 'inner-src', name: 'src', type: 'string', required: false, defaultValue: '{file.missing-inner.url}' }],
      tree: { rootNodeId: 'inner-image', nodes: makePage({ 'inner-image': { moduleId: 'base.image', propBindings: { src: { paramId: 'inner-src' } } } }, 'inner-image').nodes } }
    page.nodes.root!.children = ['nested-ref']
    page.nodes['nested-ref'] = { ...page.nodes.image!, id: 'nested-ref', moduleId: 'base.visual-component-ref', props: { componentId: 'card' } }
    site.visualComponents = [outer, inner]
    expect(() => assertSitePublicFileBindings(site)).not.toThrow()
    outer.tree.nodes['card-image']!.props.propOverrides = {}
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing-inner.url')
  })

  it('checks actual page/entry/404 template composition and nested VC params', () => {
    const { site } = fixture()
    const template = makePage({ root: { moduleId: 'base.body', children: ['outlet', 'asset'] },
      outlet: { moduleId: 'base.outlet' }, asset: { moduleId: 'base.image', props: { src: '{file.missing-template.url}' } } })
    template.id = 'template'
    template.template = { enabled: true, target: { kind: 'everywhere' }, priority: 1 }
    site.pages.push(template)
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing-template.url')
    template.nodes.asset!.props.src = '{file.manifest.url}'
    template.template.target = { kind: 'postTypes', tableSlugs: ['posts'] }
    template.seo = { links: [{ id: 'manifest', rel: 'manifest', href: '{file.missing-entry.url}' }] }
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing-entry.url')
    template.template.target = { kind: 'notFound' }
    expect(() => assertSitePublicFileBindings(site)).toThrow('file.missing-entry.url')
  })

  it('renders native metadata through either published references or an owned private frame', () => {
    const { page, site } = fixture()
    page.nodes.root!.children = []
    page.seo = { links: [{ id: 'manifest', rel: 'manifest', href: '{file.manifest.url}', type: '{file.manifest.mimeType}' }],
      structuredData: [{ image: '{file.manifest.url}' }] }
    const registry = makeRegistry({ 'base.body': makeModule('base.body') })
    const publicHtml = publishPage(page, site, registry).html
    expect(publicHtml).toContain('rel="manifest" href="/manifest.webmanifest" type="application/manifest+json"')
    const files = { manifest: { id: 'manifest', path: 'public/manifest.webmanifest', mimeType: 'application/manifest+json', url: '/admin/api/cms/runtime/files/owned/manifest' } }
    const incoming = { entryStack: [], files }
    expect(() => assertPagePublicFileBindings(page, site, incoming)).not.toThrow()
    const privateHtml = publishPage(page, site, registry, { templateContext: incoming }).html
    expect(privateHtml).toContain('rel="manifest" href="/admin/api/cms/runtime/files/owned/manifest"')
    expect(privateHtml).toContain('"image":"/admin/api/cms/runtime/files/owned/manifest"')
    site.settings.faviconUrl = '{file.manifest.url}'
    expect(publishPage(page, site, registry, { templateContext: incoming }).html).toContain('rel="icon" href="/admin/api/cms/runtime/files/owned/manifest"')
  })
})
