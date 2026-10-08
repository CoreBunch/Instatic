import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import '@modules/base'
import { registry } from '@core/module-engine'
import { escapeProps, publishPage } from '@core/publisher'
import { importHtml } from '@core/htmlImport'
import { assertSiteForms, derivePublishedPageFormSnapshots } from '@core/forms'
import { MODULE_GENERATED_ATTRIBUTE_NAMES } from '@core/htmlAttributes'
import { validateHtmlAttributeRows } from '@site/panels/PropertiesPanel/htmlAttributesModel'
import { makeNode, makePage, makeSite } from '../fixtures'

afterEach(cleanup)
const controls = ['base.input', 'base.textarea', 'base.select', 'base.checkbox', 'base.radio']

describe('native form HTML attributes', () => {
  it.each(controls)('keeps safe accessibility and authored attributes in HTML and canvas: %s', (moduleId) => {
    const definition = registry.getOrThrow(moduleId)
    const props = { ...definition.defaults, name: 'field', htmlAttributes: { tabindex: '-1', 'aria-label': 'Field "label"', 'data-purpose': 'native', hidden: '', inert: '' } }
    const html = definition.render(escapeProps(props, definition.schema), []).html
    const wrapper = document.createElement('div')
    wrapper.innerHTML = html
    const published = wrapper.firstElementChild!
    expect(published.getAttribute('tabindex')).toBe('-1')
    expect(published.getAttribute('aria-label')).toBe('Field "label"')
    expect(published.hasAttribute('hidden')).toBe(true)
    expect(published.hasAttribute('inert')).toBe(true)
    const canvas = render(React.createElement(definition.component, { nodeId: 'field', isSelected: false, props }))
    const element = canvas.container.firstElementChild!
    expect(element.getAttribute('tabindex')).toBe('-1')
    expect(element.getAttribute('aria-label')).toBe('Field "label"')
    expect(element.getAttribute('data-purpose')).toBe('native')
    expect(element.hasAttribute('hidden')).toBe(true)
    expect(element.hasAttribute('inert')).toBe(true)
  })

  it.each(controls)('protects native wiring even when booleans are false or values are empty: %s', (moduleId) => {
    const definition = registry.getOrThrow(moduleId)
    const props = { ...definition.defaults, name: 'field', htmlAttributes: { ' TYPE ': 'password', NAME: 'forged', VALUE: 'forged', DISABLED: '', REQUIRED: '', FORM: 'other', 'data-instatic-form-control': 'forged', ref: 'forged', key: 'forged', children: 'forged', onclick: 'forged', 'data-purpose': 'native' } }
    const html = definition.render(escapeProps(props, definition.schema), []).html
    expect(html).not.toContain('forged')
    expect(html).not.toContain(' disabled')
    expect(html).not.toContain(' required')
    expect(html).not.toContain(' form=')
    const canvas = render(React.createElement(definition.component, { nodeId: 'field', isSelected: false, props }))
    const element = canvas.container.firstElementChild!
    expect(element.getAttribute('name')).toBe('field')
    expect(element.hasAttribute('disabled')).toBe(false)
    expect(element.hasAttribute('required')).toBe(false)
    expect(element.hasAttribute('form')).toBe(false)
    expect(element.getAttribute('data-instatic-form-control')).toBeNull()
  })

  it('imports and publishes a text honeypot with native autocomplete and tab order', () => {
    const imported = importHtml('<form action="/recipient" method="post"><input type="text" name="website" autocomplete="off" tabindex="-1" aria-hidden="true" data-purpose="honeypot"></form>')
    const form = Object.values(imported.nodes).find((node) => node.moduleId === 'base.form')!
    const input = Object.values(imported.nodes).find((node) => node.moduleId === 'base.input')!
    expect(input.props.inputType).toBe('text')
    expect(input.props.autocomplete).toBe('off')
    expect(input.props.htmlAttributes).toEqual({ tabindex: '-1', 'aria-hidden': 'true', 'data-purpose': 'honeypot' })
    const root = makeNode({ id: 'root', moduleId: 'base.body', children: [form.id] })
    const page = makePage({ nodes: { ...imported.nodes, root } })
    const site = makeSite({ pages: [page] })
    assertSiteForms(site)
    const html = publishPage(page, site, registry).html
    expect(html).toContain('type="text"')
    expect(html).toContain('autocomplete="off"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('type="hidden"')
    form.props = { ...form.props, mode: 'cms', targetTableId: 'submissions' }
    expect(derivePublishedPageFormSnapshots(site, page)[0].controls[0].name).toBe('website')
  })

  it('reports modeled attribute names in authoring and rejects persisted collisions', () => {
    const names = MODULE_GENERATED_ATTRIBUTE_NAMES['base.input']
    expect(validateHtmlAttributeRows([{ id: 'type', name: ' TYPE ', value: 'hidden' }], names).errors).toEqual({ type: 'This attribute is managed in Module settings.' })
    const page = makePage({ nodes: {
      root: makeNode({ id: 'root', moduleId: 'base.body', children: ['form'] }),
      form: makeNode({ id: 'form', moduleId: 'base.form', props: { mode: 'custom', action: '/recipient' }, children: ['input'] }),
      input: makeNode({ id: 'input', moduleId: 'base.input', props: { name: 'field', htmlAttributes: { ' Required ': '' } } }),
    } })
    expect(() => assertSiteForms(makeSite({ pages: [page] }))).toThrow('HTML attribute is managed by native control props')
  })

  it('keeps numeric input constraints in canonical props during attribute import', () => {
    const imported = importHtml('<input type="range" name="amount" min="0" max="10" step="2" aria-label="Amount">')
    const node = Object.values(imported.nodes).find((entry) => entry.moduleId === 'base.input')!
    expect(node.props).toMatchObject({ inputType: 'range', min: '0', max: '10', step: '2', htmlAttributes: { 'aria-label': 'Amount' } })
    expect(node.props.htmlAttributes).not.toHaveProperty('step')
    const definition = registry.getOrThrow(node.moduleId)
    const html = definition.render({ ...definition.defaults, ...node.props }, []).html
    expect(html).toContain('step="2"')
  })

  it('keeps canvas focus wiring and form attributes on the native form element', () => {
    const definition = registry.getOrThrow('base.input')
    const canvas = render(React.createElement(definition.component, { nodeId: 'field', isSelected: false, nodeWrapperProps: { tabIndex: 0 }, props: { ...definition.defaults, htmlAttributes: { tabindex: '-1' } } }))
    expect(canvas.container.querySelector('input')!.tabIndex).toBe(0)
    const form = registry.getOrThrow('base.form')
    const view = render(React.createElement(form.component, { nodeId: 'form', isSelected: false, props: { ...form.defaults, htmlAttributes: { 'aria-label': 'Contact', 'data-purpose': 'contact', action: '/forged' } } }))
    expect(view.container.querySelector('form')!.getAttribute('aria-label')).toBe('Contact')
    expect(view.container.querySelector('form')!.getAttribute('data-purpose')).toBe('contact')
    expect(view.container.querySelector('form')!.hasAttribute('action')).toBe(false)
  })
})
