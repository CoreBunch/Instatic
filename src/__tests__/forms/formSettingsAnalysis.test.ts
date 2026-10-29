import { describe, expect, it } from 'bun:test'
import type { DataTable } from '@core/data/schemas'
import type { Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import {
  analyzeFormSettings,
  buildDataTableDraftFromForm,
  fieldBindingPatch,
  formDisplayName,
  formFieldFragmentForDataField,
} from '@site/panels/PropertiesPanel/formSettingsAnalysis'

function node(id: string, moduleId: string, props: Record<string, unknown> = {}, children: string[] = []): PageNode {
  return {
    id,
    moduleId,
    props,
    children,
    breakpointOverrides: {},
    classIds: [],
  }
}

const table: DataTable = {
  id: 'contact_submissions',
  name: 'Contact submissions',
  slug: 'contact-submissions',
  kind: 'data',
  singularLabel: 'Submission',
  pluralLabel: 'Submissions',
  routeBase: '',
  primaryFieldId: 'email',
  system: false,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  fields: [
    { id: 'email', label: 'Email', type: 'email', required: true, maxLength: 320 },
    { id: 'message', label: 'Message', type: 'longText', required: true },
    { id: 'plan', label: 'Plan', type: 'select', options: [
      { id: 'free', label: 'Free', value: 'free' },
      { id: 'pro', label: 'Pro', value: 'pro' },
    ] },
    { id: 'consent', label: 'Consent', type: 'boolean', required: true },
  ],
}

function makePage(): Page {
  return withParentIndex({
    id: 'page-home',
    slug: 'index',
    title: 'Home',
    rootNodeId: 'body',
    nodes: {
      body: node('body', 'base.body', {}, ['form', 'outside-input']),
      form: node('form', 'base.form', {
        mode: 'cms',
        formId: 'contact',
        targetTableId: 'contact_submissions',
      }, ['field-email', 'field-email-duplicate', 'submit']),
      'field-email': node('field-email', 'base.container', {}, ['label-email', 'input-email']),
      'label-email': node('label-email', 'base.label', { text: 'Email', targetMode: 'auto', targetId: '' }),
      'input-email': node('input-email', 'base.input', {
        fieldId: 'email',
        name: 'email',
        inputType: 'email',
      }),
      'field-email-duplicate': node('field-email-duplicate', 'base.container', {}, ['duplicate-email']),
      'duplicate-email': node('duplicate-email', 'base.input', {
        fieldId: 'missing_field',
        name: 'email',
        inputType: 'text',
      }),
      submit: node('submit', 'base.submit', { label: 'Send', formId: '' }),
      'outside-input': node('outside-input', 'base.input', { fieldId: 'email', name: 'email' }),
    },
  })
}

function withParentIndex(page: Page): Page {
  reindexNodeParents(page.nodes)
  return page
}

describe('analyzeFormSettings', () => {
  it('summarizes the selected form and warns about duplicate control names', () => {
    const page = makePage()
    const analysis = analyzeFormSettings({ page, nodeId: 'form', table })

    expect(analysis.kind).toBe('form')
    expect(analysis.form?.formId).toBe('contact')
    expect(analysis.form?.targetTableId).toBe('contact_submissions')
    expect(analysis.table?.id).toBe('contact_submissions')
    expect(analysis.missingFields.map((field) => field.id)).toEqual(['message', 'plan', 'consent'])
    expect(analysis.warnings).toContainEqual({
      code: 'duplicate_name',
      message: 'Two controls inside this form use the name "email".',
      tone: 'warning',
    })
  })

  it('finds nearest form context and bound field for a selected control', () => {
    const page = makePage()
    const analysis = analyzeFormSettings({ page, nodeId: 'input-email', table })

    expect(analysis.kind).toBe('control')
    expect(analysis.form?.nodeId).toBe('form')
    expect(analysis.field?.id).toBe('email')
    expect(analysis.compatibleFields.map((field) => field.id)).toEqual(['email', 'message'])
    expect(analysis.warnings).toEqual([])
  })

  it('warns when a selected control is outside a form', () => {
    const page = makePage()
    const analysis = analyzeFormSettings({ page, nodeId: 'outside-input', table })

    expect(analysis.kind).toBe('control')
    expect(analysis.form).toBeNull()
    expect(analysis.warnings).toContainEqual({
      code: 'outside_form',
      message: 'This control is not inside a form.',
      tone: 'warning',
    })
  })

  it('warns when a selected control is bound to a missing table field', () => {
    const page = makePage()
    const analysis = analyzeFormSettings({ page, nodeId: 'duplicate-email', table })

    expect(analysis.kind).toBe('control')
    expect(analysis.field).toBeNull()
    expect(analysis.warnings).toContainEqual({
      code: 'missing_field',
      message: 'The bound field "missing_field" no longer exists in Contact submissions.',
      tone: 'warning',
    })
  })

  it('shows inferred label and submit relationships', () => {
    const page = makePage()
    const labelAnalysis = analyzeFormSettings({ page, nodeId: 'label-email', table })
    const submitAnalysis = analyzeFormSettings({ page, nodeId: 'submit', table })

    expect(labelAnalysis.kind).toBe('label')
    expect(labelAnalysis.inferredTarget?.nodeId).toBe('input-email')
    expect(labelAnalysis.inferredTarget?.label).toBe('email')
    expect(submitAnalysis.kind).toBe('submit')
    expect(submitAnalysis.form?.formId).toBe('contact')
  })

  it('infers a create-table draft from controls inside the selected form', () => {
    const page: Page = withParentIndex({
      id: 'page-home',
      slug: 'index',
      title: 'Home',
      rootNodeId: 'body',
      nodes: {
        body: node('body', 'base.body', {}, ['form']),
        form: node('form', 'base.form', {
          mode: 'cms',
          formId: 'contact-mWEtu0Bh00K-EXHQjOspN',
          targetTableId: '',
        }, ['field-name', 'field-email', 'field-message', 'field-consent']),
        'field-name': node('field-name', 'base.container', {}, ['label-name', 'name']),
        'label-name': node('label-name', 'base.label', { text: 'Name', targetMode: 'auto', targetId: '' }),
        name: node('name', 'base.input', {
          name: 'name',
          inputType: 'text',
          required: true,
          maxLength: 120,
        }),
        'field-email': node('field-email', 'base.container', {}, ['label-email', 'email']),
        'label-email': node('label-email', 'base.label', { text: 'Email', targetMode: 'auto', targetId: '' }),
        email: node('email', 'base.input', { name: 'email', inputType: 'email', required: true }),
        'field-message': node('field-message', 'base.container', {}, ['label-message', 'message']),
        'label-message': node('label-message', 'base.label', { text: 'Message', targetMode: 'auto', targetId: '' }),
        message: node('message', 'base.textarea', { name: 'message', required: false }),
        'field-consent': node('field-consent', 'base.container', {}, ['label-consent', 'consent']),
        'label-consent': node('label-consent', 'base.label', { text: 'Consent', targetMode: 'auto', targetId: '' }),
        consent: node('consent', 'base.checkbox', { name: 'consent', required: true }),
      },
    })

    const analysis = analyzeFormSettings({ page, nodeId: 'form' })
    expect(analysis.inferredFields).toEqual([
      { id: 'name', label: 'Name', type: 'text', required: true, maxLength: 120 },
      { id: 'email', label: 'Email', type: 'email', required: true },
      { id: 'message', label: 'Message', type: 'longText' },
      { id: 'consent', label: 'Consent', type: 'boolean', required: true },
    ])

    expect(buildDataTableDraftFromForm(analysis)).toEqual({
      name: 'Contact submissions',
      slug: 'contact-submissions',
      kind: 'data',
      singularLabel: 'Submission',
      pluralLabel: 'Submissions',
      primaryFieldId: 'name',
      fields: analysis.inferredFields,
    })
  })

  it('keeps generated id suffixes out of user-facing form names', () => {
    expect(formDisplayName('contact-iA1PLODCLc4odPTZ8ljwv')).toBe('Contact')
    expect(formDisplayName('contact-mWEtu0Bh00K-EXHQjOspN')).toBe('Contact')
    expect(formDisplayName('newsletter-signup')).toBe('Newsletter Signup')
  })
})

describe('fieldBindingPatch', () => {
  it('creates a control prop patch from a compatible table field', () => {
    const email = table.fields[0]!

    expect(fieldBindingPatch(email, 'base.input')).toEqual({
      fieldId: 'email',
      name: 'email',
      id: 'email-input',
      inputType: 'email',
      required: true,
      maxLength: 320,
    })
  })

  it('maps boolean and select fields to their matching control props', () => {
    const select = table.fields[2]!
    const boolean = table.fields[3]!

    expect(fieldBindingPatch(select, 'base.select')).toEqual({
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-select',
      required: false,
      multiple: false,
    })
    expect(fieldBindingPatch(boolean, 'base.checkbox')).toEqual({
      fieldId: 'consent',
      name: 'consent',
      id: 'consent-checkbox',
      value: 'on',
      required: true,
    })
  })
})

describe('formFieldFragmentForDataField', () => {
  it('creates a label and compatible control for missing text fields', () => {
    const fragment = formFieldFragmentForDataField(table.fields[1]!)
    const wrapper = fragment.nodes[fragment.rootIds[0]!]!
    const label = fragment.nodes[wrapper.children[0]!]!
    const textarea = fragment.nodes[wrapper.children[1]!]!

    expect(wrapper.moduleId).toBe('base.container')
    expect(label.moduleId).toBe('base.label')
    expect(label.props).toMatchObject({ text: 'Message', targetMode: 'auto' })
    expect(textarea.moduleId).toBe('base.textarea')
    expect(textarea.props).toMatchObject({
      fieldId: 'message',
      name: 'message',
      id: 'message-textarea',
      required: true,
    })
  })

  it('copies select options into option child nodes', () => {
    const fragment = formFieldFragmentForDataField(table.fields[2]!)
    const wrapper = fragment.nodes[fragment.rootIds[0]!]!
    const select = fragment.nodes[wrapper.children[1]!]!
    const optionNodes = select.children.map((id) => fragment.nodes[id]!)

    expect(select.moduleId).toBe('base.select')
    expect(select.props).toMatchObject({
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-select',
      multiple: false,
    })
    expect(optionNodes.map((option) => option.moduleId)).toEqual(['base.option', 'base.option'])
    expect(optionNodes.map((option) => option.props)).toEqual([
      { label: 'Free', value: 'free', selected: false, disabled: false },
      { label: 'Pro', value: 'pro', selected: false, disabled: false },
    ])
  })
})
