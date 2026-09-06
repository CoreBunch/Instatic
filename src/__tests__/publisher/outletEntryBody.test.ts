/**
 * The content outlet is, by definition, the hole the current entry's body
 * flows into. That must hold for ANY `base.outlet` on an entry-route template —
 * including one a user drags onto a custom template by hand, which carries no
 * persisted `dynamicBindings` overlay. The publisher applies the entry-body
 * binding implicitly (see `effectiveNodeBindings`), so the body renders without
 * the node needing to remember a binding it never had a UI to set.
 */

import { describe, expect, it } from 'bun:test'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'
import { publishPage } from '@core/publisher'
import { effectiveNodeBindings, resolveDynamicProps } from '@core/templates/dynamicBindings'
import type { LoopItem } from '@core/loops/types'

const bodyModule = makeModule('base.body', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
})

// Mirrors the real base.outlet render: a hidden richtextBody `html` prop (so
// `escapeProps` sanitises via the wider POST_BODY_CONFIG rather than
// HTML-escaping it) emitted inside the content-region marker.
const outletModule = makeModule('base.outlet', {
  schema: { html: { type: 'richtextBody', label: 'Content', hidden: true } },
  render: (props) => ({
    html: `<section data-instatic-content-region>${String((props as { html?: string }).html ?? '')}</section>`,
  }),
})

const registry = makeRegistry({ 'base.body': bodyModule, 'base.outlet': outletModule })

function entry(body: string): LoopItem {
  return { id: 'p1', fields: { id: 'p1', title: 'Untitled', body } }
}

describe('entry outlet body binding', () => {
  it('renders the current entry body into an outlet that carries no persisted binding', () => {
    // A hand-dropped outlet: NO dynamicBindings on the node.
    const page = makePage({
      root: { moduleId: 'base.body', children: ['outlet'] },
      outlet: { moduleId: 'base.outlet' },
    })

    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: { entryStack: [entry('## Heading\n\nHello world')] },
    })

    expect(html).toContain('data-instatic-content-region')
    expect(html).toContain('<h2>Heading</h2>')
    expect(html).toContain('Hello world')
  })

  it('leaves the outlet empty on a non-entry render (no current entry in scope)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['outlet'] },
      outlet: { moduleId: 'base.outlet' },
    })

    // No entryStack → currentEntry.body resolves to nothing; the outlet renders
    // its marker but no body (an `everywhere` layout previewing a page relies on
    // this so the implicit binding stays inert outside entry routes).
    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: { entryStack: [] },
    })

    expect(html).toContain('data-instatic-content-region')
    expect(html).not.toContain('Hello world')
  })

  // 2026-08-13 blog round-2 regression: a raw <iframe> YouTube embed pasted
  // into a post's markdown body (the CMS has no @[video]-style syntax for
  // iframe embeds — authors paste the platform's real embed HTML) was being
  // silently stripped by the outlet's sanitizer end-to-end. This is the same
  // path the real blog posts hit: markdown body -> renderMarkdownToHtml
  // (passes raw HTML blocks through untouched) -> escapeProps ->
  // sanitizePostBody (trusted-host allowlist, not a blanket strip).
  it('renders a YouTube iframe embed pasted into the entry body, end-to-end', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['outlet'] },
      outlet: { moduleId: 'base.outlet' },
    })

    const body = [
      '## How to Run MCP Servers',
      '',
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315" allowfullscreen></iframe>',
      '',
      'More text after the embed.',
    ].join('\n')

    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: { entryStack: [entry(body)] },
    })

    expect(html).toContain('<iframe')
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ')
    expect(html).toContain('More text after the embed.')
  })

  it('strips an iframe embed from an untrusted host in the entry body, end-to-end', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['outlet'] },
      outlet: { moduleId: 'base.outlet' },
    })

    const body = '<iframe src="https://evil.com/phish"></iframe>\n\nSafe text.'

    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: { entryStack: [entry(body)] },
    })

    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('evil.com')
    expect(html).toContain('Safe text.')
  })
})

describe('canvas outlet body sanitisation (GHSA-7vxr)', () => {
  it('sanitises the resolved outlet body, since the canvas renders it via dangerouslySetInnerHTML', () => {
    // The editor canvas resolves the outlet body through resolveDynamicProps and
    // renders props.html directly, with no escapeProps pass of its own. A member
    // could publish a post whose body carries raw HTML with event handlers; when
    // an owner previews it in the Site editor the markup runs same-origin with
    // /admin. resolveDynamicProps must return a sanitised html prop.
    const bindings = effectiveNodeBindings({ moduleId: 'base.outlet' })
    const body = [
      '<p onclick="alert(1)">click</p>',
      '',
      '<a href="javascript:alert(2)">link</a>',
      '',
      '<script>alert(3)</script>',
    ].join('\n')

    const props = resolveDynamicProps({ html: '' }, bindings, { entryStack: [entry(body)] })
    const html = String(props.html)

    expect(html).not.toContain('onclick')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<script')
    // Legitimate text is preserved.
    expect(html).toContain('click')
    expect(html).toContain('link')
  })
})
