/**
 * The content outlet is, by definition, the hole the current entry's content
 * flows into. That must hold for ANY `base.outlet` on an entry-route template —
 * including one a user drags onto a custom template by hand, which carries no
 * persisted `dynamicBindings` overlay. The publisher applies the entry-body
 * binding implicitly (see `effectiveNodeBindings`), so the body renders without
 * the node needing to remember a binding it never had a UI to set.
 *
 * The implicit binding is a DEFAULT, not a lock: a persisted `html` binding on
 * the outlet node wins, so authors and plugins can point an outlet at any rich
 * field (e.g. a custom table's richText cell) instead of `body`.
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

// Mirrors the real base.outlet render: a hidden richtext `html` prop (so
// `escapeProps` sanitises rather than HTML-escapes it) emitted inside the
// content-region marker.
const outletModule = makeModule('base.outlet', {
  schema: { html: { type: 'richtext', label: 'Content', hidden: true } },
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

  it('lets a persisted html binding override the implicit body default', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['outlet'] },
      outlet: {
        moduleId: 'base.outlet',
        dynamicBindings: {
          html: { source: 'currentEntry', field: 'summary', format: 'html' },
        },
      },
    })

    const { html } = publishPage(page, makeSite(), registry, {
      templateContext: {
        entryStack: [{
          id: 'p1',
          fields: { id: 'p1', body: 'BODY — must not render', summary: '## Summary heading' },
        }],
      },
    })

    expect(html).toContain('<h2>Summary heading</h2>')
    expect(html).not.toContain('must not render')
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
