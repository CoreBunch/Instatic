import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { assertSiteForms, derivePublishedPageFormSnapshots, FormConfigurationError } from '@core/forms'
import { PublicAssetValidationError } from '@core/files/publicAssets'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { buildTemplateRenderContext, publishedRenderScopes } from '@core/templates'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'

function formPage(id: string) {
  return makePage({ id, title: id, nodes: {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['form'] }),
    form: makeNode({ id: 'form', moduleId: 'base.form', props: { mode: 'cms', formId: 'contact', targetTableId: 'submissions' }, children: ['input'] }),
    input: makeNode({ id: 'input', moduleId: 'base.input', props: { name: 'name', fieldId: 'name' } }),
  } })
}

describe('forms use native public render scopes', () => {
  it('ignores unrelated binding errors and unreachable form nodes', () => {
    const page = formPage('contact')
    page.nodes.root.children.push('image')
    page.nodes.image = makeNode({ id: 'image', moduleId: 'base.image', props: { src: '{file.absent.url}' } })
    page.nodes.orphan = makeNode({ id: 'orphan', moduleId: 'base.form', props: { mode: 'request', action: 'javascript:invalid' } })
    expect(() => assertSiteForms(makeSite({ pages: [page] }))).not.toThrow()
    expect(derivePublishedPageFormSnapshots(makeSite({ pages: [page] }), page).map((form) => form.formId)).toEqual(['contact'])
    page.nodes.input.props.value = '{file.absent.url}'
    expect(() => assertSiteForms(makeSite({ pages: [page] }))).toThrow(PublicAssetValidationError)
  })

  it('excludes losing and outletless layouts while validating emitted layout forms', () => {
    const page = formPage('contact')
    const winner = makePage({ id: 'layout', rootNodeId: 'layout-root', template: { enabled: true, target: { kind: 'everywhere' }, priority: 2 }, nodes: {
      'layout-root': makeNode({ id: 'layout-root', moduleId: 'base.body', children: ['outlet'] }),
      outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet' }),
    } })
    const loser = formPage('unused-layout')
    loser.template = { enabled: true, target: { kind: 'everywhere' }, priority: 1 }
    loser.nodes.input.props.value = '{file.absent.url}'
    const site = makeSite({ pages: [page, winner, loser] })
    expect(() => assertSiteForms(site)).not.toThrow()
    expect(derivePublishedPageFormSnapshots(site, loser)).toEqual([])
    winner.nodes['layout-root'].children.push('bad-form')
    winner.nodes['bad-form'] = makeNode({ id: 'bad-form', moduleId: 'base.form', props: { mode: 'request', action: '' } })
    expect(() => assertSiteForms(site)).toThrow('relative or HTTP(S) URL')
  })

  it('resolves effective component form props while ignoring unused params and slots', () => {
    const page = formPage('contact')
    page.nodes.form.children = ['ref']
    page.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: {
      componentId: 'field', propOverrides: { unused: '{currentEntry.unavailable}', value: 'Published value' },
    }, children: ['unused-slot'] })
    page.nodes['unused-slot'] = makeNode({ id: 'unused-slot', moduleId: 'base.slot-instance', props: { slotName: 'unused' }, children: ['input'] })
    page.nodes.input.props.value = '{file.absent.url}'
    const component = makeVC({ id: 'field', name: 'Field', params: [
      { id: 'unused', name: 'unused', type: 'string', defaultValue: '{file.absent.url}', required: false },
      { id: 'value', name: 'value', type: 'string', defaultValue: '', required: false },
    ], tree: makeVCTree('field', [makeNode({ id: 'field', moduleId: 'base.input', props: { name: 'name', fieldId: 'name' }, propBindings: { value: { paramId: 'value' } } })]) })
    const site = makeSite({ pages: [page], visualComponents: [component] })
    expect(() => assertSiteForms(site)).not.toThrow()
    expect(derivePublishedPageFormSnapshots(site, page)[0].controls.map((control) => control.nodeId)).toEqual(['ref:field'])
    page.nodes.ref.props.propOverrides = { value: '{file.absent.url}' }
    expect(() => assertSiteForms(site)).toThrow(PublicAssetValidationError)
  })

  it('keeps resolved form transport authoritative and rejects repeated form node identities', () => {
    const page = formPage('contact')
    page.nodes.form.props = { mode: '{site.name}', action: '/recipient' }
    page.nodes.input.props.value = '{currentEntry.name}'
    const site = makeSite({ name: 'request', pages: [page] })
    expect(() => assertSiteForms(site)).not.toThrow()
    page.nodes.form.children.push('input')
    expect(() => assertSiteForms(site)).toThrow('distinct instance identities')
  })

  it('reports recursive form composition as a typed configuration error', () => {
    const page = formPage('contact')
    page.nodes.form.children = ['ref']
    page.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'recursive' } })
    const component = makeVC({ id: 'recursive', name: 'Recursive', tree: makeVCTree('nested-ref', [
      makeNode({ id: 'nested-ref', moduleId: 'base.visual-component-ref', props: { componentId: 'recursive' } }),
    ]) })
    const site = makeSite({ pages: [page], visualComponents: [component] })
    expect(() => assertSiteForms(site)).toThrow(FormConfigurationError)
    expect(() => assertSiteForms(site)).toThrow('Recursive Visual Component')
  })

  it('prevents unrelated authored ids from overwriting a materialized form control', () => {
    const page = formPage('contact')
    page.nodes.form.children = ['ref']
    page.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'field' } })
    page.nodes.root.children.push('ref:field')
    page.nodes['ref:field'] = makeNode({ id: 'ref:field', moduleId: 'base.image' })
    const component = makeVC({ id: 'field', name: 'Field', tree: makeVCTree('field', [
      makeNode({ id: 'field', moduleId: 'base.input', props: { name: 'name', fieldId: 'name' } }),
    ]) })
    expect(() => assertSiteForms(makeSite({ pages: [page], visualComponents: [component] }))).toThrow('distinct instance identities')
  })

  it('matches terminal page bindings in composed publisher output and submission authority', () => {
    const page = formPage('contact')
    page.slug = 'contact'
    page.nodes.form.children.unshift('label')
    page.nodes.label = makeNode({ id: 'label', moduleId: 'base.label', props: { text: '{page.id}|{page.slug}|{page.permalink}|{page.isTemplate}|{page.title}' } })
    const layout = makePage({ id: 'layout', slug: 'chrome', title: 'Layout title', rootNodeId: 'layout-root', template: { enabled: true, target: { kind: 'everywhere' }, priority: 0 }, nodes: {
      'layout-root': makeNode({ id: 'layout-root', moduleId: 'base.body', children: ['outlet'] }),
      outlet: makeNode({ id: 'outlet', moduleId: 'base.outlet' }),
    } })
    const site = makeSite({ pages: [page, layout] })
    const [scope] = publishedRenderScopes(site)
    const [snapshot] = derivePublishedPageFormSnapshots(site, page)
    expect(snapshot.pageId).toBe(page.id)
    expect(snapshot.labels[0].text).toBe('contact|contact|/contact|false|contact')
    expect(publishPage(scope.page, site, registry, { templateContext: buildTemplateRenderContext(page, site, undefined) }).html).toContain(`${snapshot.labels[0].text}</label>`)
  })

  it('validates the winning 404 without resolving the losing raw template', () => {
    const winner = formPage('winning-404'), loser = formPage('losing-404')
    winner.template = { enabled: true, target: { kind: 'notFound' }, priority: 1 }
    loser.template = { enabled: true, target: { kind: 'notFound' }, priority: 0 }
    loser.nodes.input.props.value = '{file.absent.url}'
    const site = makeSite({ pages: [winner, loser] })
    expect(() => assertSiteForms(site)).not.toThrow()
    expect(derivePublishedPageFormSnapshots(site, winner)).toHaveLength(1)
    expect(derivePublishedPageFormSnapshots(site, loser)).toEqual([])
    winner.nodes.input.props.lockQueryValue = true
    expect(() => assertSiteForms(site)).toThrow('Query locking requires')
  })

  it('keeps stable CMS entry forms and rejects bindings needing per-entry authority', () => {
    const template = formPage('entry-template')
    template.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts', 'news'] }, priority: 0 }
    const site = makeSite({ pages: [template] })
    expect(() => assertSiteForms(site)).not.toThrow()
    expect(derivePublishedPageFormSnapshots(site, template)).toHaveLength(1)
    template.nodes.input.props.value = '{currentEntry.title}'
    template.nodes.input.dynamicBindings = { value: { source: 'site', field: 'name' } }
    expect(() => assertSiteForms(site)).not.toThrow()
    template.nodes.input.dynamicBindings.value.field = 'absent'
    expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    template.nodes.input.dynamicBindings.value.fallback = 'empty'
    expect(() => assertSiteForms(site)).not.toThrow()
    template.nodes.input.dynamicBindings.value = { source: 'site', field: 'name' }
    for (const value of ['{currentEntry.title}', '{route.slug}']) {
      site.name = value
      expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    }
    site.name = 'Site'
    site.files.push({ id: 'reference', type: 'asset', path: 'public/info.txt', blob: { mimeType: 'text/plain', base64: '' }, createdAt: 0, updatedAt: 0 })
    template.nodes.input.dynamicBindings.value = { source: 'file', field: 'reference.path' }
    expect(() => assertSiteForms(site)).not.toThrow()
    site.files[0].path = 'public/{route.slug}.txt'
    expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    template.nodes.input.dynamicBindings.value.field = 'reference.url'
    expect(() => assertSiteForms(site)).not.toThrow()
    delete template.nodes.input.dynamicBindings
    for (const value of ['{currentEntry.title}', '{route.pathname}', '{page.title}']) {
      template.nodes.input.props.value = value
      expect(() => assertSiteForms(site)).toThrow(FormConfigurationError)
      expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    }
    template.nodes.input.props.value = ''
    template.nodes.input.dynamicBindings = { value: { source: 'page', field: 'title' } }
    expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    template.nodes.form.props = { mode: 'request', formId: 'contact', action: '/recipient' }
    expect(() => assertSiteForms(site)).not.toThrow()
    template.nodes.form.dynamicBindings = { mode: { source: 'currentEntry', field: 'transport' } }
    expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    delete template.nodes.form.dynamicBindings
    template.nodes.form.props.mode = '{route.query.transport|request}'
    expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
  })
})
