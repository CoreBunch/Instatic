/**
 * closestReadonlyRegion — the boundary resolver that decides whether a hovered
 * / double-clicked canvas element is read-only composed chrome or the active
 * document's own editable content.
 *
 * Regression: the active page's content is spliced into a wrapping template's
 * outlet, so editable nodes live INSIDE the read-only wrapper element. Walking
 * straight to the nearest `[data-instatic-readonly-*]` ancestor wrongly treated
 * that editable content as read-only — the hover hint fired over the whole page
 * and double-click opened the template instead of editing the node.
 */
import { describe, it, expect } from 'bun:test'
import { closestReadonlyRegion, isElementLike } from '@site/canvas/readonlyRegion'

function readonly(tag: string): HTMLElement {
  const el = document.createElement(tag)
  el.setAttribute('data-instatic-readonly-label', 'Main template')
  el.setAttribute('data-instatic-readonly-kind', 'page')
  el.setAttribute('data-instatic-readonly-id', 'tpl-main')
  return el
}

describe('closestReadonlyRegion', () => {
  it('returns null for editable content spliced inside a read-only template wrapper', () => {
    // <div readonly="Main template"><h1 data-node-id>ABOUT</h1></div>
    const wrapper = readonly('div')
    const heading = document.createElement('h1')
    heading.setAttribute('data-node-id', 'abc')
    wrapper.appendChild(heading)
    expect(closestReadonlyRegion(heading)).toBeNull()
  })

  it('returns null for a descendant of editable content even when both sit in a readonly wrapper', () => {
    const wrapper = readonly('div')
    const heading = document.createElement('h1')
    heading.setAttribute('data-node-id', 'abc')
    const span = document.createElement('span') // module-internal markup, unmarked
    heading.appendChild(span)
    wrapper.appendChild(heading)
    expect(closestReadonlyRegion(span)).toBeNull()
  })

  it('returns the region element for read-only template chrome', () => {
    const nav = readonly('nav')
    expect(closestReadonlyRegion(nav)?.getAttribute('data-instatic-readonly-label')).toBe('Main template')
  })

  it('returns the read-only ancestor for an unmarked child of chrome (e.g. a logo image)', () => {
    const nav = readonly('nav')
    const img = document.createElement('img')
    nav.appendChild(img)
    const region = closestReadonlyRegion(img)
    expect(region?.getAttribute('data-instatic-readonly-id')).toBe('tpl-main')
    expect(region?.getAttribute('data-instatic-readonly-kind')).toBe('page')
  })

  it('returns null for a plain editable node with no readonly ancestor', () => {
    const h = document.createElement('h1')
    h.setAttribute('data-node-id', 'x')
    expect(closestReadonlyRegion(h)).toBeNull()
  })

  it('returns null for non-element targets', () => {
    expect(closestReadonlyRegion(null)).toBeNull()
    expect(closestReadonlyRegion(document.createTextNode('x') as unknown as EventTarget)).toBeNull()
  })
})

describe('isElementLike', () => {
  it('duck-types cross-realm elements via closest', () => {
    expect(isElementLike(document.createElement('div'))).toBe(true)
    expect(isElementLike(null)).toBe(false)
    expect(isElementLike(document.createTextNode('x') as unknown as EventTarget)).toBe(false)
  })
})
