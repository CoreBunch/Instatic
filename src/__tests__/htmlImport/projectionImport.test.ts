/**
 * Uid-preserving projection import (God Mode ticket 03).
 *
 * Renders real trees through the publisher's projection dialect
 * (`RenderConfig.projection`) with the REAL module registry, then imports the
 * HTML back via `importProjectionHtml` and asserts:
 *
 *   - unchanged HTML round-trips to a deep-equal tree with identical ids
 *   - edits patch only the touched node; siblings keep ids and metadata
 *   - new tags create, removed tags delete, reorders move (no delete+recreate)
 *   - instatic-component / instatic-slot / instatic-loop round-trip with
 *     props intact (loop `filters` patched as a partial view)
 *   - the diff summary flags destructive deletions (locked / structural)
 */

import { describe, it, expect } from 'bun:test'
// Self-registers all base modules with the global registry singleton.
import '@modules/base'
import { registry } from '@core/module-engine'
import { renderNode, type RenderConfig } from '@core/publisher'
import type { PageNode, Page, StyleRule } from '@core/page-tree'
import { importProjectionHtml, importHtml } from '@core/htmlImport'
import { makePage, makeSite, makeAccumulators } from '../publisher/helpers'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function defaults(moduleId: string): Record<string, unknown> {
  return { ...(registry.getOrThrow(moduleId).defaults as Record<string, unknown>) }
}

const HERO_RULE: StyleRule = {
  id: 'cls-hero',
  name: 'hero',
  kind: 'class',
  selector: '.hero',
  order: 0,
  styles: {},
}

const STYLE_RULES: Record<string, StyleRule> = { [HERO_RULE.id]: HERO_RULE }

function projectionConfig(page: Page): RenderConfig {
  return {
    page,
    site: makeSite({ styleRules: STYLE_RULES }),
    registry,
    breakpointId: undefined,
    projection: true,
  }
}

function renderProjection(page: Page, rootId = 'root'): string {
  return renderNode(rootId, projectionConfig(page), makeAccumulators())
}

/** Strip parentId + undefined-valued keys for structural comparison. */
function comparable(node: PageNode): Record<string, unknown> {
  const { parentId: _p, ...rest } = node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function comparableNodes(nodes: Record<string, PageNode>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(nodes).map(([id, n]) => [id, comparable(n)]))
}

/** A representative mixed tree: container > text, link, loop(text), VC ref(slot(text)). */
function mixedPage(): Page {
  return makePage({
    root: {
      moduleId: 'base.container',
      props: { ...defaults('base.container'), tag: 'section' },
      classIds: ['cls-hero'],
      children: ['heading', 'cta', 'loop1', 'vc1'],
    },
    heading: {
      moduleId: 'base.text',
      props: { ...defaults('base.text'), text: 'Hello world', tag: 'h2' },
      label: 'Page heading',
    },
    cta: {
      moduleId: 'base.link',
      props: { ...defaults('base.link'), text: 'Read more', href: '/posts', target: '_self' },
    },
    loop1: {
      moduleId: 'base.loop',
      props: {
        ...defaults('base.loop'),
        sourceId: 'data.rows',
        filters: { tableId: 'tbl-1', pluginKey: 'kept' },
        orderBy: 'createdAt',
        direction: 'desc',
        limit: 5,
        offset: 0,
      },
      children: ['loopItem'],
    },
    loopItem: {
      moduleId: 'base.text',
      props: { ...defaults('base.text'), text: '{currentEntry.title}', tag: 'p' },
    },
    vc1: {
      moduleId: 'base.visual-component-ref',
      props: { componentId: 'vc-def-1', propOverrides: { tone: 'bold' } },
      children: ['slot1'],
    },
    slot1: {
      moduleId: 'base.slot-instance',
      props: { ...defaults('base.slot-instance'), slotName: 'children' },
      locked: true,
      children: ['fill1'],
    },
    fill1: {
      moduleId: 'base.text',
      props: { ...defaults('base.text'), text: 'Slot fill', tag: 'p' },
    },
  })
}

function importBack(page: Page, html: string, rootId = 'root') {
  return importProjectionHtml(html, { tree: page, rootId, styleRules: STYLE_RULES })
}

// ---------------------------------------------------------------------------
// Round-trip identity
// ---------------------------------------------------------------------------

describe('projection import — round-trip identity', () => {
  it('imports an unchanged projection to a deep-equal tree with identical ids', () => {
    const page = mixedPage()
    const html = renderProjection(page)
    const result = importBack(page, html)

    expect(Object.keys(result.nodes).sort()).toEqual(Object.keys(page.nodes).sort())
    expect(comparableNodes(result.nodes)).toEqual(comparableNodes(page.nodes))
    expect(result.rootId).toBe('root')
    expect(result.diff.createdIds).toEqual([])
    expect(result.diff.patchedIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('round-trips author class names back to registry class ids', () => {
    const page = mixedPage()
    const html = renderProjection(page)
    expect(html).toContain('class="hero"')
    const result = importBack(page, html)
    expect(result.nodes.root!.classIds).toEqual(['cls-hero'])
  })

  it('round-trips inline styles onto the node inlineStyles layer', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'div' },
        inlineStyles: { color: 'red' },
        children: [],
      },
    })
    const html = renderProjection(page)
    expect(html).toContain('style=')
    const result = importBack(page, html)
    expect(result.nodes.root!.inlineStyles).toEqual({ color: 'red' })
    expect(result.diff.patchedIds).toEqual([])
  })

  it('round-trips multi-line text (rendered as <br>) to one base.text node', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'div' },
        children: ['t1'],
      },
      t1: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Get the\nfile-based', tag: 'h2' },
      },
    })
    const html = renderProjection(page)
    expect(html).toContain('<br>')
    const result = importBack(page, html)
    expect(result.nodes.t1!.moduleId).toBe('base.text')
    expect(result.nodes.t1!.props.text).toBe('Get the\nfile-based')
    expect(result.diff.patchedIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
  })

  it('round-trips bare text children by positional adoption (id preserved)', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'div' },
        children: ['bare1'],
      },
      bare1: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Direct text', tag: 'none' },
        label: 'Kept label',
      },
    })
    const html = renderProjection(page)
    const result = importBack(page, html)
    expect(result.nodes.bare1).toBeDefined()
    expect(result.nodes.bare1!.props.text).toBe('Direct text')
    expect(result.nodes.bare1!.label).toBe('Kept label')
    expect(result.diff.createdIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
  })

  it('round-trips a base.body page projection in children mode', () => {
    const page = makePage({
      root: { moduleId: 'base.body', props: defaults('base.body'), children: ['a', 'b'] },
      a: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'First', tag: 'p' },
      },
      b: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Second', tag: 'p' },
      },
    })
    const html = renderProjection(page)
    // base.body emits no wrapper element — the projection is the children only.
    expect(html).not.toContain('uid="root"')
    const result = importBack(page, html)
    expect(comparableNodes(result.nodes)).toEqual(comparableNodes(page.nodes))
    expect(result.diff.patchedIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
  })

  it('round-trips loop/outlet author htmlAttributes and keeps tokens verbatim', () => {
    const page = makePage({
      root: {
        moduleId: 'base.loop',
        props: {
          ...defaults('base.loop'),
          sourceId: 'data.rows',
          htmlAttributes: { 'data-track': '{currentEntry.id}' },
        },
        children: ['item'],
      },
      item: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: '{currentEntry.title}', tag: 'p' },
      },
    })
    const html = renderProjection(page)
    expect(html).toContain('data-track="{currentEntry.id}"')
    const result = importBack(page, html)
    expect(result.nodes.root!.props.htmlAttributes).toEqual({
      'data-track': '{currentEntry.id}',
    })
    expect(result.nodes.item!.props.text).toBe('{currentEntry.title}')
    expect(result.diff.patchedIds).toEqual([])
  })

  it('never leaks the uid attribute into props.htmlAttributes', () => {
    const page = mixedPage()
    const result = importBack(page, renderProjection(page))
    for (const node of Object.values(result.nodes)) {
      const attrs = node.props.htmlAttributes as Record<string, string> | undefined
      expect(attrs?.uid).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

describe('projection import — patching', () => {
  it('an attribute/text edit patches only that node; siblings keep ids + metadata', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace('Hello world', 'Hi there')
    const result = importBack(page, html)

    expect(result.diff.patchedIds).toEqual(['heading'])
    expect(result.diff.createdIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
    expect(result.nodes.heading!.props.text).toBe('Hi there')
    // uid-carried metadata survives the patch
    expect(result.nodes.heading!.label).toBe('Page heading')
    // untouched siblings are structurally identical
    expect(comparable(result.nodes.cta!)).toEqual(comparable(page.nodes.cta!))
    expect(comparable(result.nodes.loop1!)).toEqual(comparable(page.nodes.loop1!))
  })

  it('preserves breakpoint overrides, bindings, and flags through a patch', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'div' },
        children: ['t1'],
      },
      t1: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Bound', tag: 'p' },
        hidden: true,
        breakpointOverrides: { mobile: { tag: 'h3' } },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = renderProjection(page).replace('Bound', 'Rebound')
    const result = importBack(page, html)
    const t1 = result.nodes.t1!
    expect(t1.props.text).toBe('Rebound')
    expect(t1.hidden).toBe(true)
    expect(t1.breakpointOverrides).toEqual({ mobile: { tag: 'h3' } })
    expect(t1.dynamicBindings).toEqual({ text: { source: 'currentEntry', field: 'title' } })
  })

  it('re-tagging keeps the node id and metadata but switches module', () => {
    const page = mixedPage()
    // <h2 …>Hello world</h2> → <div …>Hello world</div> re-types text → container
    const html = renderProjection(page)
      .replace(/<h2 /, '<div ')
      .replace('</h2>', '</div>')
    const result = importBack(page, html)

    expect(result.diff.deletedIds).toEqual([])
    expect(result.nodes.heading!.moduleId).toBe('base.container')
    expect(result.nodes.heading!.label).toBe('Page heading')
    expect(result.diff.patchedIds).toContain('heading')
  })

  it('patches the loop filters bag as a partial view (plugin keys survive)', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace('data-table-id="tbl-1"', 'data-table-id="tbl-2"')
    const result = importBack(page, html)
    expect(result.nodes.loop1!.props.filters).toEqual({ tableId: 'tbl-2', pluginKey: 'kept' })
    expect(result.diff.patchedIds).toEqual(['loop1'])
  })

  it('removing data-table-id clears only filters.tableId', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace(' data-table-id="tbl-1"', '')
    const result = importBack(page, html)
    expect(result.nodes.loop1!.props.filters).toEqual({ pluginKey: 'kept' })
  })

  it('round-trips an infinite-pagination loop and preserves pageSize otherwise', () => {
    const infinitePage = makePage({
      root: {
        moduleId: 'base.loop',
        props: {
          ...defaults('base.loop'),
          sourceId: 'data.rows',
          pagination: 'infinite',
          pageSize: 25,
        },
        children: ['item'],
      },
      item: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: '{currentEntry.title}', tag: 'p' },
      },
    })
    const roundTrip = importBack(infinitePage, renderProjection(infinitePage))
    expect(roundTrip.nodes.root!.props.pagination).toBe('infinite')
    expect(roundTrip.nodes.root!.props.pageSize).toBe(25)
    expect(roundTrip.diff.patchedIds).toEqual([])

    // A none-pagination loop projects no data-page-size, so a stored pageSize
    // survives the round trip untouched.
    const nonePage = makePage({
      root: {
        moduleId: 'base.loop',
        props: { ...defaults('base.loop'), sourceId: 'data.rows', pageSize: 25 },
        children: ['item'],
      },
      item: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: '{currentEntry.title}', tag: 'p' },
      },
    })
    const noneTrip = importBack(nonePage, renderProjection(nonePage))
    expect(noneTrip.nodes.root!.props.pageSize).toBe(25)
    expect(noneTrip.diff.patchedIds).toEqual([])
  })

  it('editing bare text adopts the existing node id (patched, not recreated)', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'div' },
        children: ['bare1'],
      },
      bare1: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Before', tag: 'none' },
      },
    })
    const html = renderProjection(page).replace('Before', 'After')
    const result = importBack(page, html)
    expect(result.nodes.bare1!.props.text).toBe('After')
    expect(result.diff.createdIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
    expect(result.diff.patchedIds).toContain('bare1')
  })
})

// ---------------------------------------------------------------------------
// Create / delete / move
// ---------------------------------------------------------------------------

describe('projection import — create, delete, move', () => {
  it('a new tag creates a node; siblings are untouched', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace('</section>', '<p>Brand new</p></section>')
    const result = importBack(page, html)

    expect(result.diff.createdIds).toHaveLength(1)
    const createdId = result.diff.createdIds[0]!
    expect(result.nodes[createdId]!.moduleId).toBe('base.text')
    expect(result.nodes[createdId]!.props.text).toBe('Brand new')
    expect(result.nodes.root!.children).toContain(createdId)
    expect(result.diff.deletedIds).toEqual([])
  })

  it('a removed tag deletes the node (and its subtree)', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace(/<h2 [^>]*>Hello world<\/h2>/, '')
    const result = importBack(page, html)

    expect(result.diff.deletedIds).toEqual(['heading'])
    expect(result.diff.deletedLockedIds).toEqual([])
    expect(result.diff.deletedStructuralIds).toEqual([])
    expect(result.nodes.heading).toBeUndefined()
  })

  it('reordering siblings moves nodes — nothing is created or deleted', () => {
    const page = mixedPage()
    const html = renderProjection(page)
    const h2 = html.match(/<h2 [^>]*>Hello world<\/h2>/)![0]
    const a = html.match(/<a [^>]*>Read more<\/a>/)![0]
    const swapped = html.replace(h2 + a, a + h2)
    expect(swapped).not.toBe(html)

    const result = importBack(page, swapped)
    expect(result.diff.createdIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
    expect(result.nodes.root!.children.slice(0, 2)).toEqual(['cta', 'heading'])
    // the reorder registers as a patch of the parent, not of the children
    expect(result.diff.patchedIds).toEqual(['root'])
  })

  it('an element moved between parents keeps its id', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'div' },
        children: ['boxA', 'boxB'],
      },
      boxA: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'section' },
        children: ['t1'],
      },
      boxB: {
        moduleId: 'base.container',
        props: { ...defaults('base.container'), tag: 'aside' },
        children: [],
      },
      t1: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Mover', tag: 'p' },
      },
    })
    const html = renderProjection(page)
    const p = html.match(/<p [^>]*>Mover<\/p>/)![0]
    const moved = html.replace(p, '').replace(/<aside ([^>]*)>/, `<aside $1>${p}`)
    const result = importBack(page, moved)

    expect(result.diff.createdIds).toEqual([])
    expect(result.diff.deletedIds).toEqual([])
    expect(result.nodes.boxA!.children).toEqual([])
    expect(result.nodes.boxB!.children).toEqual(['t1'])
    expect(comparable(result.nodes.t1!)).toEqual(comparable(page.nodes.t1!))
  })

  it('flags deletions of locked nodes and Component/slot structures', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace(
      /<instatic-component[\s\S]*<\/instatic-component>/,
      '',
    )
    const result = importBack(page, html)

    expect(result.diff.deletedIds.sort()).toEqual(['fill1', 'slot1', 'vc1'])
    expect(result.diff.deletedLockedIds).toEqual(['slot1'])
    expect(result.diff.deletedStructuralIds.sort()).toEqual(['slot1', 'vc1'])
    expect(result.diff.retypedStructuralIds).toEqual([])
  })

  it('flags re-tagging a Component marker away from its structural module', () => {
    const page = mixedPage()
    // <instatic-component uid="vc1" …> → <div uid="vc1" …>: the node survives
    // but the VC-ref structure is dismantled — as destructive as deleting it.
    const html = renderProjection(page)
      .replace('<instatic-component ', '<div ')
      .replace('</instatic-component>', '</div>')
    const result = importBack(page, html)

    expect(result.nodes.vc1!.moduleId).toBe('base.container')
    expect(result.diff.deletedIds).toEqual([])
    expect(result.diff.retypedStructuralIds).toEqual(['vc1'])
    expect(result.diff.patchedIds).toContain('vc1')
  })

  it('an unknown uid mints a new node instead of stealing one', () => {
    const page = mixedPage()
    const html = renderProjection(page).replace(
      '</section>',
      '<p uid="not-in-subtree">Alien</p></section>',
    )
    const result = importBack(page, html)
    expect(result.diff.createdIds).toHaveLength(1)
    expect(result.diff.createdIds[0]).not.toBe('not-in-subtree')
    expect(result.nodes['not-in-subtree']).toBeUndefined()
  })

  it('a duplicated uid patches the first occurrence and creates the second', () => {
    const page = mixedPage()
    const html = renderProjection(page)
    const h2 = html.match(/<h2 [^>]*>Hello world<\/h2>/)![0]
    const result = importBack(page, html.replace(h2, h2 + h2))

    expect(result.diff.createdIds).toHaveLength(1)
    expect(result.diff.deletedIds).toEqual([])
    expect(result.nodes.heading).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// instatic-* round-trips through the shared (lossy) dialect
// ---------------------------------------------------------------------------

describe('projection import — instatic-* structural tags', () => {
  it('round-trips component/slot structure with props intact', () => {
    const page = mixedPage()
    const result = importBack(page, renderProjection(page))
    expect(result.nodes.vc1!.moduleId).toBe('base.visual-component-ref')
    expect(result.nodes.vc1!.props.componentId).toBe('vc-def-1')
    // unprojected props survive the patch
    expect(result.nodes.vc1!.props.propOverrides).toEqual({ tone: 'bold' })
    expect(result.nodes.slot1!.moduleId).toBe('base.slot-instance')
    expect(result.nodes.slot1!.props.slotName).toBe('children')
    expect(result.nodes.slot1!.locked).toBe(true)
    expect(result.nodes.slot1!.children).toEqual(['fill1'])
  })

  it('round-trips a slot outlet with its default content', () => {
    const page = makePage({
      root: {
        moduleId: 'base.slot-outlet',
        props: { ...defaults('base.slot-outlet'), slotName: 'media' },
        children: ['fallback'],
      },
      fallback: {
        moduleId: 'base.text',
        props: { ...defaults('base.text'), text: 'Default content', tag: 'p' },
      },
    })
    const result = importBack(page, renderProjection(page))
    expect(comparableNodes(result.nodes)).toEqual(comparableNodes(page.nodes))
    expect(result.diff.patchedIds).toEqual([])
  })

  it('the lossy importHtml path also accepts the component/slot tags', () => {
    const { nodes, rootIds } = importHtml(
      '<instatic-component data-component-id="vc-9">' +
        '<instatic-slot data-slot-name="children"><p>Fill</p></instatic-slot>' +
        '</instatic-component>',
    )
    const ref = nodes[rootIds[0]!]!
    expect(ref.moduleId).toBe('base.visual-component-ref')
    expect(ref.props.componentId).toBe('vc-9')
    const slot = nodes[ref.children[0]!]!
    expect(slot.moduleId).toBe('base.slot-instance')
    expect(slot.props.slotName).toBe('children')
    expect(slot.locked).toBe(true)
    expect(nodes[slot.children[0]!]!.moduleId).toBe('base.text')
  })
})
