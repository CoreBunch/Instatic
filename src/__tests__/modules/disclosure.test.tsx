import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { escapeProps } from '@core/publisher'
import { Value } from '@core/utils/typeboxHelpers'
import { DisclosureModule } from '@modules/base/disclosure'
import { DisclosurePropsSchema } from '@modules/base/disclosure/props'
import { DisclosureEditor } from '@modules/base/disclosure/DisclosureEditor'
import { installDisclosureBehavior } from '@modules/base/disclosure/behavior'
import { DISCLOSURE_RUNTIME_JS } from '@modules/base/disclosure/disclosureRuntimeJs'

afterEach(cleanup)

describe('native disclosure authoring and publishing', () => {
  it('preserves an authored summary with independently styled content, grouping and state', () => {
    const props = { ...DisclosureModule.defaults, group: 'navigation', initiallyOpen: true }
    expect(Value.Check(DisclosurePropsSchema, props)).toBe(true)
    const result = DisclosureModule.render(escapeProps(props, DisclosureModule.schema), ['<summary class="trigger" aria-label="Products"><i class="icon" aria-hidden="true">+</i><span>Products &amp; services</span><i class="chevron" aria-hidden="true">⌄</i></summary>', '<a href="/products">Products</a>'])
    const host = document.createElement('div')
    host.innerHTML = result.html
    const details = host.querySelector('details')!
    expect(details.firstElementChild?.tagName).toBe('SUMMARY')
    const summary = details.querySelector('summary')!
    expect(summary.className).toBe('trigger')
    expect(summary.getAttribute('aria-label')).toBe('Products')
    expect(summary.children).toHaveLength(3)
    expect(summary.children[1].textContent).toBe('Products & services')
    expect(details.children).toHaveLength(2)
    expect(details.getAttribute('name')).toBe('navigation')
    expect(details.open).toBe(true)
    expect(details.getAttribute('role')).toBeNull()
    expect(result.css).toBeUndefined()
    expect(result.js).toBe(DISCLOSURE_RUNTIME_JS)
  })

  it('escapes group names, rejects runtime attribute overrides and generates no implicit summary', () => {
    const props = { ...DisclosureModule.defaults, group: '" onclick="alert(1)', htmlAttributes: { open: '', name: 'override', 'data-instatic-close-on-escape': 'false', onclick: 'alert(1)' } }
    const result = DisclosureModule.render(escapeProps(props, DisclosureModule.schema), [])
    const host = document.createElement('div')
    host.innerHTML = result.html
    const details = host.querySelector('details')!
    expect(host.querySelector('script')).toBeNull()
    expect(details.getAttribute('onclick')).toBeNull()
    expect(details.open).toBe(false)
    expect(details.getAttribute('name')).toBe(props.group)
    expect(details.getAttribute('data-instatic-close-on-escape')).toBe('true')
    expect(details.querySelector('summary')).toBeNull()
    expect(DisclosureModule.schema).not.toHaveProperty('label')
    expect(DisclosureModule.defaults).not.toHaveProperty('label')
  })

  it('canvas preserves wrapper/class attributes and uses the same Escape/focus behavior', () => {
    const view = render(<DisclosureEditor props={{ ...DisclosureModule.defaults, initiallyOpen: true }} nodeId="disclosure" isSelected={false} mcClassName="navigation-panel" nodeWrapperProps={{ 'data-node-id': 'disclosure' }}><summary className="trigger" data-node-id="summary"><span>Products</span><i aria-hidden="true">⌄</i></summary><a href="/products">Products</a></DisclosureEditor>)
    const details = view.container.querySelector('details')!
    expect(details.className).toBe('navigation-panel')
    expect(details.getAttribute('data-node-id')).toBe('disclosure')
    expect(details.querySelectorAll('summary')).toHaveLength(1)
    expect(details.querySelector('summary')?.getAttribute('data-node-id')).toBe('summary')
    const link = details.querySelector('a')!
    link.focus()
    fireEvent.keyDown(link, { key: 'Escape' })
    expect(details.open).toBe(false)
    expect(document.activeElement).toBe(details.querySelector('summary'))
  })
})

describe('delegated disclosure behavior', () => {
  const releases: Array<() => void> = []
  afterEach(() => { for (const release of releases.splice(0)) release(); document.body.replaceChildren() })

  function fixture(options: Partial<typeof DisclosureModule.defaults> = {}) {
    const host = document.createElement('div')
    host.innerHTML = DisclosureModule.render({ ...DisclosureModule.defaults, ...options }, ['<summary>Menu</summary>', '<a href="/item">Item</a><button>Action</button>']).html + '<button id="outside">Outside</button>'
    document.body.append(host)
    const details = host.querySelector('details')!
    return { host, details, trigger: details.querySelector('summary')!, link: details.querySelector('a')!, outside: host.querySelector<HTMLButtonElement>('#outside')! }
  }

  function attach() { releases.push(installDisclosureBehavior(document)) }

  it('works for a late-inserted disclosure and closes the innermost panel with Escape', () => {
    attach()
    const outer = fixture({ initiallyOpen: true })
    const inner = fixture({ initiallyOpen: true })
    outer.details.append(inner.host)
    inner.link.focus()
    fireEvent.keyDown(inner.link, { key: 'Escape' })
    expect(inner.details.open).toBe(false)
    expect(outer.details.open).toBe(true)
    expect(document.activeElement).toBe(inner.trigger)
  })

  it('honors disabled Escape and an already-handled key', () => {
    attach()
    const f = fixture({ initiallyOpen: true, closeOnEscape: false })
    f.link.focus()
    fireEvent.keyDown(f.link, { key: 'Escape' })
    expect(f.details.open).toBe(true)
    f.details.setAttribute('data-instatic-close-on-escape', 'true')
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    f.link.dispatchEvent(event)
    expect(f.details.open).toBe(true)
  })

  it('outside pointer closes only opted-in panels and restores concealed focus', () => {
    attach()
    const f = fixture({ initiallyOpen: true, closeOnOutsidePointer: true })
    const persistent = fixture({ initiallyOpen: true })
    f.link.focus()
    fireEvent.pointerDown(f.link, { button: 0 })
    expect(f.details.open).toBe(true)
    fireEvent.pointerDown(f.outside, { button: 2 })
    expect(f.details.open).toBe(true)
    fireEvent.pointerDown(f.outside, { button: 0 })
    expect(f.details.open).toBe(false)
    expect(persistent.details.open).toBe(true)
    expect(document.activeElement).toBe(f.trigger)
    f.outside.focus()
    expect(document.activeElement).toBe(f.outside)
  })

  it('focus leaving closes the panel without redirecting the new focus', () => {
    attach()
    const f = fixture({ initiallyOpen: true, closeOnFocusLeave: true })
    f.link.focus()
    expect(f.details.open).toBe(true)
    f.outside.focus()
    expect(f.details.open).toBe(false)
    expect(document.activeElement).toBe(f.outside)
  })

  it('treats controls in a panel shadow tree as internal and closes with Escape', () => {
    attach()
    const f = fixture({ initiallyOpen: true, closeOnOutsidePointer: true, closeOnFocusLeave: true })
    const host = document.createElement('div')
    f.details.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const control = document.createElement('button')
    control.textContent = 'Plugin action'
    shadow.append(control)
    control.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, bubbles: true, composed: true }))
    expect(f.details.open).toBe(true)
    control.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true, composed: true }))
    expect(f.details.open).toBe(true)
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }))
    expect(f.details.open).toBe(false)
    expect(document.activeElement).toBe(f.trigger)
  })

  it('native/scripted closing does not leave focus inside a concealed panel', () => {
    attach()
    const f = fixture({ initiallyOpen: true })
    f.link.focus()
    f.details.open = false
    f.details.dispatchEvent(new Event('toggle'))
    expect(document.activeElement).toBe(f.trigger)
  })

  it('shares listeners across mounts and removes them after the last lease', () => {
    const a = installDisclosureBehavior(document)
    const b = installDisclosureBehavior(document)
    const f = fixture({ initiallyOpen: true })
    a(); a()
    fireEvent.keyDown(f.trigger, { key: 'Escape' })
    expect(f.details.open).toBe(false)
    b()
    f.details.open = true
    fireEvent.keyDown(f.trigger, { key: 'Escape' })
    expect(f.details.open).toBe(true)
  })

  it('the emitted JavaScript is self-contained and shares the same delegated behavior', () => {
    // Execute the exact owned module asset, without importing its implementation
    // into that scope. Return its lease solely to clean up this test document.
    const execute = new Function('document', 'return ' + DISCLOSURE_RUNTIME_JS)
    const release = execute(document) as () => void
    releases.push(release)
    const f = fixture({ initiallyOpen: true, closeOnOutsidePointer: true })
    f.link.focus()
    fireEvent.keyDown(f.link, { key: 'Escape' })
    expect(f.details.open).toBe(false)
    expect(document.activeElement).toBe(f.trigger)
    f.details.open = true
    fireEvent.pointerDown(f.outside, { button: 0 })
    expect(f.details.open).toBe(false)
  })
})
