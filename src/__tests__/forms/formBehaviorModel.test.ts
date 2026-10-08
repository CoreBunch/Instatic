import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { registry } from '@core/module-engine'
import { publishPage, assertSiteTranslations } from '@core/publisher'
import { assertSiteForms, derivePublishedPageFormSnapshots, validateFormSubmission, resolveInitialFormValues } from '@core/forms'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'
import { DataTableSchema } from '@core/data/schemas'
import { Value } from '@sinclair/typebox/value'
import { buildTemplateRenderContext } from '@core/templates'

const LANGUAGES = ['it','en','de','fr','es','pt','nl','pl','ro']
function fixture() {
  const files = LANGUAGES.map((language) => ({ id: language, path: `locales/${language}.json`, type: 'config' as const,
    content: JSON.stringify({ language, messages: { forms: { label: `${language} label & copy`, send: `${language} send`, placeholder: `${language} placeholder`, pending: `${language} pending`, success: `${language} success`, error: `${language} error` } } }), createdAt: 0, updatedAt: 0 }))
  const component = makeVC({ id: 'native-form', params: [
    { id: 'identity', name: 'identity', type: 'string', defaultValue: 'contact', required: true },
    { id: 'label', name: 'label', type: 'string', defaultValue: '{site.translations.forms.label}', required: true },
    { id: 'fields', name: 'fields', type: 'slot', defaultValue: [], required: false },
  ], tree: makeVCTree('form', [
    makeNode({ id: 'form', moduleId: 'base.form', props: { mode: 'cms', formId: '', targetTableId: 'submissions', pendingMessage: '{site.translations.forms.pending}', successMessage: '{site.translations.forms.success}', errorMessage: '{site.translations.forms.error}' }, propBindings: { formId: { paramId: 'identity' } }, children: ['label','selector','group','outlet','submit'] }),
    makeNode({ id: 'label', moduleId: 'base.label', props: { text: '' }, propBindings: { text: { paramId: 'label' } } }),
    makeNode({ id: 'selector', moduleId: 'base.select', props: { name: 'purpose', fieldId: 'purpose', queryParameter: 'purpose' }, children: ['basic','advanced'] }),
    makeNode({ id: 'basic', moduleId: 'base.option', props: { value: 'basic', label: 'Basic' } }),
    makeNode({ id: 'advanced', moduleId: 'base.option', props: { value: 'advanced', label: 'Advanced' } }),
    makeNode({ id: 'group', moduleId: 'base.form-conditional', props: { condition: { field: 'purpose', eq: 'advanced' } }, children: ['detail'] }),
    makeNode({ id: 'detail', moduleId: 'base.textarea', props: { name: 'details', fieldId: 'details', requiredWhen: { field: 'purpose', eq: 'advanced' } } }),
    makeNode({ id: 'outlet', moduleId: 'base.slot-outlet', props: { slotName: 'fields' } }),
    makeNode({ id: 'submit', moduleId: 'base.submit', props: { label: '{site.translations.forms.send}' } }),
  ]) })
  const page = makePage({ language: 'it', nodes: {
    root: makeNode({ id: 'root', moduleId: 'base.body', children: ['ref'] }),
    ref: makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: component.id }, children: ['slot'] }),
    slot: makeNode({ id: 'slot', moduleId: 'base.slot-instance', props: { slotName: 'fields' }, children: ['email'] }),
    email: makeNode({ id: 'email', moduleId: 'base.input', props: { inputType: 'email', name: 'email', fieldId: 'email' }, dynamicBindings: { placeholder: { source: 'site', field: 'translations.forms.placeholder' } } }),
  } })
  const site = makeSite({ pages: [page], visualComponents: [component], files, settings: { language: 'it', shortcuts: {}, localization: { catalogues: files.map((file) => ({ language: file.id, fileId: file.id })) } } })
  return { site, page, component }
}

describe('native form composition and published authority', () => {
  it('uses identical language files and frames for publisher and CMS snapshots in nine languages', () => {
    const { site, page } = fixture()
    assertSiteTranslations(site)
    for (const language of LANGUAGES) {
      const localized = { ...page, language }
      const model = { ...site, pages: [localized] }
      assertSiteForms(model)
      const [snapshot] = derivePublishedPageFormSnapshots(model, localized)
      const html = publishPage(localized, model, registry).html
      expect(snapshot.formId).toBe('contact')
      expect(snapshot.labels[0].text).toBe(`${language} label & copy`)
      expect(snapshot.submits[0].label).toBe(`${language} send`)
      expect(snapshot.controls.map((control) => control.fieldId)).toEqual(['purpose','details','email'])
      expect(html).toContain(`<html lang="${language}">`)
      expect(html).toContain(`${language} label &amp; copy</label>`)
      expect(html).toContain(`placeholder="${language} placeholder"`)
      expect(html).toContain(`data-instatic-pending-message="${language} pending"`)
      expect(html).toContain(' hidden>')
      expect(html).toContain(' disabled')
      expect(html).not.toContain('{site.translations')
      expect(html).not.toContain('locales/')
      expect(html).not.toContain('<instatic-hole')
    }
  })

  it('rejects duplicate rendered form IDs while preserving different native VC params', () => {
    const { site, page } = fixture()
    page.nodes.root.children.push('second')
    page.nodes.second = makeNode({ id: 'second', moduleId: 'base.visual-component-ref', props: { componentId: 'native-form' } })
    expect(() => assertSiteForms(site)).toThrow('Duplicate form ID')
    page.nodes.second.props.propOverrides = { identity: 'second-contact' }
    expect(() => assertSiteForms(site)).not.toThrow()
    expect(derivePublishedPageFormSnapshots(site, page).map((form) => form.formId)).toEqual(['contact','second-contact'])
  })

  it('recomputes active and required controls from the published definition and validates offered options', () => {
    const { site, page } = fixture()
    const [snapshot] = derivePublishedPageFormSnapshots(site, page)
    const table = { ...Value.Create(DataTableSchema), id: 'submissions', fields: [{ id: 'purpose', label: 'Purpose', type: 'text' as const }, { id: 'details', label: 'Details', type: 'longText' as const }, { id: 'email', label: 'Email', type: 'email' as const }] }
    function check(values: Record<string, unknown>) { return validateFormSubmission({ table, controls: snapshot.controls, values }) }
    expect(check({ purpose: 'basic' }).ok).toBe(true)
    expect(check({ purpose: 'advanced' }).ok).toBe(false)
    expect(check({ purpose: 'advanced', details: 'Required detail' }).ok).toBe(true)
    const inactive = check({ purpose: 'basic', details: 'Forged inactive value' })
    expect(inactive.ok).toBe(false)
    if (!inactive.ok) expect(inactive.errors[0].code).toBe('unknown_field')
    const unoffered = check({ purpose: 'forged' })
    expect(unoffered.ok).toBe(false)
    if (!unoffered.ok) expect(unoffered.errors[0].code).toBe('invalid_option')
  })

  it('blocks undeclared condition selectors and unsupported vendor CAPTCHA on CMS forms', () => {
    const { site, component } = fixture()
    component.tree.nodes.group.props.condition = { field: 'missing-control', eq: 'value' }
    expect(() => assertSiteForms(site)).toThrow('enabled scalar control')
    component.tree.nodes.group.props.condition = null
    component.tree.nodes.form.children.push('captcha')
    component.tree.nodes.captcha = makeNode({ id: 'captcha', moduleId: 'base.turnstile', props: { siteKey: 'public-key', action: '', language: 'it', theme: 'auto', responseFieldName: 'token' } })
    expect(() => assertSiteForms(site)).toThrow('server-side verification')
    component.tree.nodes.form.props.mode = 'request'
    component.tree.nodes.form.props.action = 'https://recipient.example/form'
    expect(() => assertSiteForms(site)).not.toThrow()
    component.tree.nodes.captcha.props.siteKey = ''
    expect(() => assertSiteForms(site)).toThrow('explicit public Turnstile site key')
  })

  it('blocks invalid endpoints, response contracts and native behavior without enhancement', () => {
    const { site, component } = fixture()
    const props = component.tree.nodes.form.props
    props.mode = 'request'; props.action = 'javascript:alert(1)'
    expect(() => assertSiteForms(site)).toThrow('HTTP(S) URL')
    props.action = '/submit'; props.responseSuccessField = 'same'; props.responseMessageField = 'same'
    expect(() => assertSiteForms(site)).toThrow('must be distinct')
    props.mode = 'custom'
    expect(() => assertSiteForms(site)).toThrow('Enable form behavior')
    props.enhance = true
    expect(() => assertSiteForms(site)).not.toThrow()
  })

  it('validates radio groups from active published options without weakening requiredness', () => {
    const { site, page, component } = fixture()
    component.tree.nodes.form.children = ['radio-a', 'radio-b']
    component.tree.nodes['radio-a'] = makeNode({ id: 'radio-a', moduleId: 'base.radio', props: { name: 'choice', fieldId: 'choice', value: 'a', required: true } })
    component.tree.nodes['radio-b'] = makeNode({ id: 'radio-b', moduleId: 'base.radio', props: { name: 'choice', fieldId: 'choice', value: 'b' } })
    const table = { ...Value.Create(DataTableSchema), fields: [{ id: 'choice', label: 'Choice', type: 'text' as const }] }
    const [snapshot] = derivePublishedPageFormSnapshots(site, page)
    const check = (values: Record<string, unknown>) => validateFormSubmission({ table, controls: snapshot.controls, values })
    expect(check({ choice: 'a' }).ok).toBe(true)
    expect(check({ choice: 'b' }).ok).toBe(true)
    expect(check({}).ok).toBe(false)
    expect(check({ choice: 'forged' }).ok).toBe(false)
    expect(check({ choice: ['a','b'] }).ok).toBe(false)
    component.tree.nodes['radio-b'].props.disabled = true
    const [disabled] = derivePublishedPageFormSnapshots(site, page)
    expect(validateFormSubmission({ table, controls: disabled.controls, values: { choice: 'b' } }).ok).toBe(false)
  })

  it('rejects file loss, implicit query locks and unsupported CAPTCHA languages', () => {
    const { site, component } = fixture()
    const form = component.tree.nodes.form
    form.children.push('file')
    component.tree.nodes.file = makeNode({ id: 'file', moduleId: 'base.input', props: { inputType: 'file', name: 'attachment' } })
    expect(() => assertSiteForms(site)).toThrow('multipart submission')
    form.props.mode = 'request'; form.props.action = '/recipient'; form.props.encoding = 'json'
    expect(() => assertSiteForms(site)).toThrow('multipart submission')
    form.props.encoding = 'multipart'
    expect(() => assertSiteForms(site)).not.toThrow()
    delete component.tree.nodes.file; form.children.pop()
    component.tree.nodes.selector.props.lockQueryValue = true
    delete component.tree.nodes.selector.props.queryParameter
    expect(() => assertSiteForms(site)).toThrow('Query locking requires')
    component.tree.nodes.selector.props.queryParameter = 'purpose'
    form.children.push('captcha')
    component.tree.nodes.captcha = makeNode({ id: 'captcha', moduleId: 'base.turnstile', props: { siteKey: 'public-key', action: '', language: 'not-a-language', theme: 'auto', responseFieldName: 'token' } })
    expect(() => assertSiteForms(site)).toThrow('documented language code')
  })

  it('derives SSR values only from successful controls, preserving multiple-select defaults', () => {
    const { site, page, component } = fixture()
    component.tree.nodes.detail.props.value = 'Inactive authored detail'
    component.tree.nodes.form.children.push('choices')
    component.tree.nodes.choices = makeNode({ id: 'choices', moduleId: 'base.select', props: { name: 'choices', multiple: true }, children: ['choice-a', 'choice-b', 'choice-c'] })
    for (const [id, selected] of [['a', true], ['b', false], ['c', true]] as const) component.tree.nodes['choice-' + id] = makeNode({ id: 'choice-' + id, moduleId: 'base.option', props: { value: id, selected } })
    const expanded = { ...page, nodes: component.tree.nodes, rootNodeId: 'form' }
    const values = resolveInitialFormValues(site, expanded, 'form', buildTemplateRenderContext(page, site, undefined))
    expect(values.choices).toEqual(['a', 'c'])
    expect(values.details).toBeUndefined()
    component.tree.nodes['choice-a'].props.selected = false
    component.tree.nodes['choice-c'].props.selected = false
    expect(resolveInitialFormValues(site, expanded, 'form', buildTemplateRenderContext(page, site, undefined)).choices).toEqual([])
  })

  it('rejects synchronized sources that can disappear from successful controls', () => {
    for (const sourceProps of [
      { moduleId: 'base.checkbox', props: { checked: true } },
      { moduleId: 'base.radio', props: { checked: false } },
      { moduleId: 'base.input', props: { disabled: true } },
      { moduleId: 'base.input', props: { inputType: 'file' } },
      { moduleId: 'base.select', props: { multiple: true } },
    ]) {
      const { site, component } = fixture()
      component.tree.nodes.form.props.mode = 'request'; component.tree.nodes.form.props.action = '/recipient'
      component.tree.nodes.form.children.push('source', 'mirror')
      component.tree.nodes.source = makeNode({ id: 'source', moduleId: sourceProps.moduleId, props: { name: 'source', ...sourceProps.props } })
      component.tree.nodes.mirror = makeNode({ id: 'mirror', moduleId: 'base.input', props: { name: 'mirror', inputType: 'hidden', valueSourceField: 'source' } })
      expect(() => assertSiteForms(site)).toThrow('always submitted')
    }
    const { site, component } = fixture()
    component.tree.nodes.form.children.push('mirror')
    component.tree.nodes.mirror = makeNode({ id: 'mirror', moduleId: 'base.input', props: { name: 'mirror', inputType: 'hidden', valueSourceField: 'details' } })
    expect(() => assertSiteForms(site)).toThrow('outside conditional groups')
  })

  it('rejects form instances without a stable published submission authority', () => {
    const { site, page } = fixture()
    page.nodes.email.dynamicBindings = { value: { source: 'currentEntry', field: 'email' } }
    expect(() => assertSiteForms(site)).toThrow('entry-specific submission authority')
    delete page.nodes.email.dynamicBindings
    page.nodes.root.moduleId = 'base.loop'
    expect(() => assertSiteForms(site)).toThrow('outside content loops')
    page.nodes.root.hidden = true
    expect(() => assertSiteForms(site)).not.toThrow()
  })
})
