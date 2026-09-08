import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { importHtml } from '@core/htmlImport'
import { registry } from '@core/module-engine'
import { publishPage } from '@core/publisher'
import { makePage, makeSite } from '../publisher/helpers'

function roundTrip(source: string): HTMLElement {
  const imported = importHtml(source)
  const page = makePage(imported.nodes, imported.rootIds[0]!)
  const { html } = publishPage(page, makeSite(), registry)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body.firstElementChild as HTMLElement
}

describe('imported inline whitespace survives publishing', () => {
  for (const separator of ['\n', '\r\n', '\n  \t', ' ']) {
    it(`collapses ${JSON.stringify(separator)} between spans to a text-node space`, () => {
      const root = roundTrip(`<div><span>Tel</span>${separator}<span>Fax</span></div>`)
      expect(root.textContent).toBe('Tel Fax')
      expect(root.childNodes).toHaveLength(3)
      expect(root.childNodes[1]!.nodeType).toBe(Node.TEXT_NODE)
      expect(root.childNodes[1]!.textContent).toBe(' ')
    })
  }

  it('retains wrapping opportunities between Winbro-style nowrap contact entries', () => {
    const root = roundTrip(`<div>
      <span style="white-space: nowrap">Tel: <a href="tel:18039859481">1-803-985-9481</a><br></span>
      <span style="white-space: nowrap">Fax: <a href="tel:441530516001">+44 (0)1530 516 001</a></span>
      <span style="white-space: nowrap">Email: <a href="mailto:sales@example.com">sales@example.com</a></span>
    </div>`)
    const entries = root.querySelectorAll(':scope > span')
    expect(entries).toHaveLength(3)
    expect(entries[0]!.nextSibling!.textContent).toBe(' ')
    expect(entries[1]!.nextSibling!.textContent).toBe(' ')
    expect(root.querySelectorAll('br')).toHaveLength(1)
  })

  it('preserves whitespace for elements whose inline layout comes from CSS', () => {
    const root = roundTrip('<section><div style="display: inline">Tel</div>\n<div style="display: inline">Fax</div></section>')
    expect(root.textContent).toBe('Tel Fax')
    expect(root.childNodes[1]!.nodeType).toBe(Node.TEXT_NODE)
  })

  it('does not add a space where adjacent inline elements had none', () => {
    const root = roundTrip('<div><span>Win</span><span>bro</span></div>')
    expect(root.textContent).toBe('Winbro')
    expect(root.childNodes).toHaveLength(2)
  })

  it('keeps separators around comments without rendering the comments', () => {
    const root = roundTrip('<div><span>Tel</span><!-- contact -->\n<span>Fax</span></div>')
    expect(root.textContent).toBe('Tel Fax')
    expect(root.childNodes).toHaveLength(3)
  })

  it('trims parent-edge indentation without introducing wrappers between blocks', () => {
    const root = roundTrip('<section>\n  <div>One</div>\n  <div>Two</div>\n</section>')
    expect(root.children).toHaveLength(2)
    expect(root.firstChild!.nodeType).toBe(Node.ELEMENT_NODE)
    expect(root.lastChild!.nodeType).toBe(Node.ELEMENT_NODE)
    expect(root.childNodes[1]!.nodeType).toBe(Node.TEXT_NODE)
    expect(root.childNodes[1]!.textContent).toBe(' ')
  })

  it('does not turn formatting whitespace into an empty CMS loop variant', () => {
    const imported = importHtml(`<instatic-loop>
      <article><span>First</span>\n<span>variant</span></article>
      <article>Second variant</article>
    </instatic-loop>`)
    const loop = imported.nodes[imported.rootIds[0]!]!
    expect(loop.children).toHaveLength(2)
    const first = imported.nodes[loop.children[0]!]!
    expect(first.children.map((id) => imported.nodes[id]!.props.text)).toEqual(['First', ' ', 'variant'])
  })
})
