/**
 * structurePreservation.test.ts — text/phrasing elements that wrap nested
 * markup recurse (instead of flattening), and <pre> preserves whitespace.
 *
 * Reproduces the two import regressions reported on the instatic site:
 *   - `<h2>Get the<br/>file-based CMS.</h2>` rendered "Get thefile-based CMS."
 *   - `<span><span>Auth & access</span><span>Sessions…</span></span>` merged into
 *     "Auth & accessSessions…"
 *   - the terminal `<pre>` collapsed onto a single line.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { importHtml } from '@core/htmlImport'
import { TextModule } from '@modules/base/text'

function childrenOf(html: string) {
  const r = importHtml(html)
  const root = r.nodes[r.rootIds[0]!]!
  return { root, kids: root.children.map((id) => r.nodes[id]!) }
}

describe('<br> inside a heading is preserved', () => {
  it('heading with <br> recurses and keeps the break + both text halves', () => {
    const { root, kids } = childrenOf('<h2>Get the<br/>file-based CMS.</h2>')
    expect(root.moduleId).toBe('base.container')
    expect(root.props.customTag).toBe('h2')
    const tags = kids.map((k) => k.props.customTag ?? k.moduleId)
    expect(tags).toContain('br') // the line break survives as a node
    const texts = kids
      .filter((k) => k.moduleId === 'base.text' && k.props.tag === 'none')
      .map((k) => k.props.text)
    expect(texts).toContain('Get the')
    expect(texts).toContain('file-based CMS.')
  })
})

describe('nested phrasing spans are preserved (not flattened)', () => {
  it('a span wrapping two spans recurses into two distinct text children', () => {
    const { root, kids } = childrenOf(
      '<span class="led-txt"><span class="led-k">Auth &amp; access</span><span class="led-v">Sessions, MFA.</span></span>',
    )
    expect(root.moduleId).toBe('base.container')
    expect(root.props.customTag).toBe('span')
    const texts = kids.map((k) => k.props.text)
    expect(texts).toContain('Auth & access')
    expect(texts).toContain('Sessions, MFA.')
    // class names ride along so .led-k / .led-v styling still applies
    expect(kids.map((k) => k.classIds).flat()).toEqual(
      expect.arrayContaining(['led-k', 'led-v']),
    )
  })
})

describe('<pre> preserves significant whitespace', () => {
  it('keeps newlines between lines of a code block', () => {
    const r = importHtml('<pre><code><span>line one</span>\n<span>line two</span></code></pre>')
    const newlineNode = Object.values(r.nodes).find(
      (n) => n.moduleId === 'base.text' && n.props.tag === 'none' && n.props.text === '\n',
    )
    expect(newlineNode).toBeDefined()

    // No-wrapper text must publish back to the same literal text node. Turning
    // this into <br> changes childNodes and breaks scripts that snapshot code
    // blocks before animating them (for example typewriter effects).
    const { html } = TextModule.render(newlineNode!.props, [])
    expect(html).toBe('\n')
  })

  it('outside <pre>, newlines between inline siblings collapse', () => {
    const r = importHtml('<p><span>a</span>\n<span>b</span></p>')
    const hasNewline = Object.values(r.nodes).some(
      (n) => typeof n.props.text === 'string' && n.props.text.includes('\n'),
    )
    expect(hasNewline).toBe(false)
  })
})

describe('compound buttons keep what they wrap', () => {
  it('an a.btn wrapping an icon recurses into base.link, keeping href + children', () => {
    const { root, kids } = childrenOf(
      '<a class="btn" href="/download" target="_blank"><svg viewBox="0 0 1 1"></svg><span>Download</span></a>',
    )

    // base.button is canHaveChildren:false, so a compound .btn has to land on
    // the child-capable anchor module or the icon is dropped on import.
    expect(root.moduleId).toBe('base.link')
    expect(root.props.href).toBe('/download')
    expect(root.props.target).toBe('_blank')

    expect(kids.map((k) => k.moduleId)).toContain('base.svg')
    const texts = kids.filter((k) => k.moduleId === 'base.text').map((k) => k.props.text)
    expect(texts).toContain('Download')

    // the btn class still rides along, so the module swap does not restyle it
    expect(root.classIds).toEqual(expect.arrayContaining(['btn']))
  })

  it('a text-only a.btn stays a childless base.button', () => {
    const { root } = childrenOf('<a class="btn" href="/pricing">See pricing</a>')
    expect(root.moduleId).toBe('base.button')
    expect(root.props.label).toBe('See pricing')
    expect(root.props.href).toBe('/pricing')
    expect(root.children).toHaveLength(0)
  })

  it('a button wrapping an image + label recurses into a button-tagged container', () => {
    const { root, kids } = childrenOf(
      '<button><img src="/shot.png"><span>Open screenshot</span></button>',
    )
    expect(root.moduleId).toBe('base.container')
    expect(root.props.customTag).toBe('button')

    const images = kids.filter((k) => k.moduleId === 'base.image')
    expect(images).toHaveLength(1)
    expect(images[0]!.props.src).toBe('/shot.png')
    const texts = kids.filter((k) => k.moduleId === 'base.text').map((k) => k.props.text)
    expect(texts).toContain('Open screenshot')
  })

  it('a text-only button stays a childless base.button', () => {
    const { root } = childrenOf('<button type="button">Play</button>')
    expect(root.moduleId).toBe('base.button')
    expect(root.props.label).toBe('Play')
    expect(root.children).toHaveLength(0)
  })

  it('a submit button stays base.submit even when compound', () => {
    // core/forms finds a form's submit control by module id, so a compound
    // submit must not be re-tagged as a container. It keeps only its label.
    const r = importHtml('<form><button><svg viewBox="0 0 1 1"></svg><span>Send</span></button></form>')
    const submit = Object.values(r.nodes).find((n) => n.moduleId === 'base.submit')
    expect(submit).toBeDefined()
    expect(submit!.children).toHaveLength(0)
  })
})
