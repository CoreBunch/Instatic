/**
 * `data-style` / `data-class` custom attributes must never be mistaken for the
 * real `style` / `class` attribute by root-element injection.
 *
 * With `<form data-style="spinner-only">` and inline styles on the node, the
 * old /\bstyle="…"/ lookup matched after the hyphen in `data-style`, merged
 * the declarations into that data attribute, and emitted no real `style`
 * attribute. Class injection had the same flaw for `data-class`.
 */
import { describe, it, expect } from 'bun:test'
import { injectNodeInlineStyles, injectNodeClassIds } from '@core/publisher'
import { makeSite } from './helpers'

const site = makeSite({
  styleRules: {
    'row-id': {
      id: 'row-id',
      name: 'row',
      kind: 'class',
      selector: '.row',
      order: 0,
      styles: {},
      contextStyles: {},
    },
  },
})

describe('style injection ignores data-style', () => {
  it('inserts a real style attribute instead of merging into data-style', () => {
    const html = '<form class="customForm" data-style="spinner-only">x</form>'
    const out = injectNodeInlineStyles(html, { display: 'flex', gap: '8px' })
    expect(out).toContain('data-style="spinner-only"')
    expect(out).toContain('style="display: flex; gap: 8px"')
    expect(out).not.toContain('spinner-only; display')
  })

  it('still merges into a genuine style attribute that follows data-style', () => {
    const html = '<form data-style="spinner-only" style="color: red">x</form>'
    const out = injectNodeInlineStyles(html, { display: 'flex' })
    expect(out).toContain('data-style="spinner-only"')
    expect(out).toContain('style="color: red; display: flex"')
  })

  it('merge behaviour on a plain style attribute is unchanged', () => {
    const out = injectNodeInlineStyles('<div style="color: red">x</div>', { display: 'flex' })
    expect(out).toBe('<div style="color: red; display: flex">x</div>')
  })
})

describe('class injection ignores data-class', () => {
  it('inserts a real class attribute instead of merging into data-class', () => {
    const out = injectNodeClassIds('<div data-class="fancy">x</div>', ['row-id'], site)
    expect(out).toContain('data-class="fancy"')
    expect(out).toContain('class="row"')
    expect(out).not.toContain('row fancy')
  })

  it('still prepends onto a genuine class attribute alongside data-class', () => {
    const out = injectNodeClassIds(
      '<div data-class="fancy" class="existing">x</div>',
      ['row-id'],
      site,
    )
    expect(out).toContain('data-class="fancy"')
    expect(out).toContain('class="row existing"')
  })
})
