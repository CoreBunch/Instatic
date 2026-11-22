/**
 * `composeTemplateChain` must leave the pages it is given untouched.
 *
 * On the public path those pages belong to the cached published site, and the
 * hole endpoint validates every baked placeholder against that site's
 * fingerprint. Composition used to recompute `parentId` in place on node
 * objects it shared with the source pages, so rendering one entry route
 * changed the cached site's fingerprint and every baked page's fragments came
 * back stale.
 */
import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import { composeTemplateChain } from '@core/templates'

function node(id: string, moduleId: string, children: string[] = []): PageNode {
  return { id, moduleId, props: {}, breakpointOverrides: {}, children, classIds: [] }
}

function page(id: string, nodes: PageNode[], template?: Page['template']): Page {
  return {
    id,
    slug: id,
    title: id,
    rootNodeId: nodes[0].id,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    ...(template ? { template } : {}),
  }
}

function layout(): Page {
  return page(
    'layout',
    [node('layout_root', 'base.body', ['layout_header', 'layout_outlet']), node('layout_header', 'base.text'), node('layout_outlet', 'base.outlet')],
    { enabled: true, target: { kind: 'everywhere' }, priority: 0 },
  )
}

function entryTemplate(): Page {
  return page(
    'post-template',
    [node('tpl_root', 'base.body', ['tpl_title', 'tpl_outlet']), node('tpl_title', 'base.text'), node('tpl_outlet', 'base.outlet')],
    { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 0 },
  )
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe('composeTemplateChain inputs', () => {
  it('composes an entry route without writing to the template pages', () => {
    const chain = deepFreeze([layout(), entryTemplate()])
    const before = JSON.stringify(chain)

    const merged = composeTemplateChain(chain, { kind: 'entry' })

    expect(JSON.stringify(chain)).toBe(before)
    // The composed copy still carries the derived parent index.
    expect(merged.nodes.layout_header.parentId).toBe('layout_root')
    expect(merged.nodes.t0_tpl_title.parentId).toBe('layout_root')
  })

  it('composes a page route without writing to the template or the page', () => {
    const chain = deepFreeze([layout()])
    const terminal = deepFreeze(page('about', [node('about_root', 'base.body', ['about_text']), node('about_text', 'base.text')]))
    const before = JSON.stringify([chain, terminal])

    const merged = composeTemplateChain(chain, { kind: 'page', page: terminal })

    expect(JSON.stringify([chain, terminal])).toBe(before)
    expect(merged.nodes.c0_about_text.parentId).toBe('layout_root')
  })
})
