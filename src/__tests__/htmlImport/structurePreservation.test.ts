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
import type { PageNode } from '@core/page-tree'
import { importHtml } from '@core/htmlImport'

function normalizeFragment(fragment: ReturnType<typeof importHtml>): void {
  for (const id of Object.keys(fragment.nodes)) {
    const node = fragment.nodes[id]
    if (node?.moduleOverlay) {
      fragment.nodes[id] = {
        ...node,
        moduleId: node.moduleOverlay.moduleId,
        props: { ...node.props, ...node.moduleOverlay.props },
      } as PageNode
    }
  }
}

function childrenOf(html: string) {
  const r = importHtml(html)
  normalizeFragment(r)
  const root = r.nodes[r.rootIds[0]!]!
  return { root, kids: root.children.map((id) => r.nodes[id]!) }
}

describe('<br> inside a heading is preserved', () => {
  it('heading with <br> recurses and keeps the break + both text halves', () => {
    const { root, kids } = childrenOf('<h2>Get the<br/>file-based CMS.</h2>')
    expect(root.moduleId).toBe('')
    expect(root.tag).toBe('h2')
    const tags = kids.map((k) => k.tag ?? k.moduleId)
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
    expect(root.moduleId).toBe('')
    expect(root.tag).toBe('span')
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
    // Some descendant text node must carry the literal newline.
    const hasNewline = Object.values(r.nodes).some(
      (n) => typeof n.props.text === 'string' && n.props.text.includes('\n'),
    )
    expect(hasNewline).toBe(true)
  })

  it('outside <pre>, newlines between inline siblings collapse', () => {
    const r = importHtml('<p><span>a</span>\n<span>b</span></p>')
    const hasNewline = Object.values(r.nodes).some(
      (n) => typeof n.props.text === 'string' && n.props.text.includes('\n'),
    )
    expect(hasNewline).toBe(false)
  })
})
