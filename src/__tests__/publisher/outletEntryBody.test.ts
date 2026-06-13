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
