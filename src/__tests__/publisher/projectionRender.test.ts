/**
 * Editable HTML projection render (God Mode ticket 02).
 *
 * `RenderConfig.projection` renders a subtree as God Mode's editable HTML
 * dialect: tokens verbatim, hidden nodes included, and the structural
 * modules emitted as instatic-* marker tags instead of expanded output:
 *
 *   base.loop                 → <instatic-loop …>   (children once, as template)
 *   base.visual-component-ref → <instatic-component …> (internals NOT expanded)
 *   base.slot-instance        → <instatic-slot …>   (user content editable)
 *   base.slot-outlet          → <instatic-slot-outlet …>
 *   base.outlet               → <instatic-outlet …>
 *
 * Identity travels via uid (annotateNodeIds) only — locked/label/bindings
 * metadata never lands in the HTML.
 */

import { describe, it, expect } from 'bun:test'
import { renderNode, type RenderConfig } from '@core/publisher'
import type { ModuleDefinition } from '@core/module-engine'
import type { Page } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { makeModule, makeRegistry, makePage, makeSite, makeAccumulators } from './helpers'

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const textDef: ModuleDefinition<{ text: string }> = makeModule('base.text', {
  render: (props) => ({ html: `<p>${props.text}</p>` }),
})

const containerDef: ModuleDefinition = makeModule('base.container', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: `<div>${children.join('')}</div>` }),
})

const loopDef: ModuleDefinition = makeModule('base.loop', {
  canHaveChildren: true,
  publishBehavior: 'special',
  render: () => ({ html: '' }),
})

const vcRefDef: ModuleDefinition = makeModule('base.visual-component-ref', {
  canHaveChildren: true,
  publishBehavior: 'special',
  render: () => ({ html: '' }),
})

const slotInstanceDef: ModuleDefinition = makeModule('base.slot-instance', {
  canHaveChildren: true,
  render: () => ({ html: '' }),
})

const slotOutletDef: ModuleDefinition = makeModule('base.slot-outlet', {
  canHaveChildren: true,
  render: () => ({ html: '' }),
})

const outletDef: ModuleDefinition = makeModule('base.outlet', {
  render: () => ({ html: '<main data-outlet></main>' }),
})

const registry = makeRegistry({
  'base.text': textDef,
  'base.container': containerDef,
  'base.loop': loopDef,
  'base.visual-component-ref': vcRefDef,
  'base.slot-instance': slotInstanceDef,
  'base.slot-outlet': slotOutletDef,
  'base.outlet': outletDef,
})

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function projectionCtx(page: Page, overrides: Partial<RenderConfig> = {}): RenderConfig {
  return {
    page,
    site: makeSite(),
    registry,
    breakpointId: undefined,
    projection: true,
    annotateNodeIds: true,
    ...overrides,
  }
}

function publishCtx(page: Page, overrides: Partial<RenderConfig> = {}): RenderConfig {
  return { page, site: makeSite(), registry, breakpointId: undefined, ...overrides }
}

const ENTRY = { id: 'row-1', fields: { title: 'Resolved Title' } }

// ---------------------------------------------------------------------------
// Token preservation
// ---------------------------------------------------------------------------

describe('projection — token preservation', () => {
  const page = () =>
    makePage({
      root: { moduleId: 'base.text', props: { text: '{currentEntry.title}' } },
    })

  it('publish render interpolates tokens against the template context', () => {
    const html = renderNode('root', publishCtx(page(), {
      templateContext: { entryStack: [ENTRY] },
    }), makeAccumulators())
    expect(html).toContain('Resolved Title')
    expect(html).not.toContain('{currentEntry.title}')
  })

  it('projection leaves tokens verbatim even when a context is present', () => {
    const html = renderNode('root', projectionCtx(page(), {
      templateContext: { entryStack: [ENTRY] },
    }), makeAccumulators())
    expect(html).toContain('{currentEntry.title}')
    expect(html).not.toContain('Resolved Title')
  })

  it('projection ignores structured dynamicBindings (static prop value shows)', () => {
    const bound = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: 'Static value' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = renderNode('root', projectionCtx(bound, {
      templateContext: { entryStack: [ENTRY] },
    }), makeAccumulators())
    expect(html).toContain('Static value')
    expect(html).not.toContain('Resolved Title')
  })
})

// ---------------------------------------------------------------------------
// uid + hidden nodes + metadata
// ---------------------------------------------------------------------------

describe('projection — identity and metadata', () => {
  it('projection implies uid annotation even without annotateNodeIds', () => {
    const page = makePage({
      root: { moduleId: 'base.container', children: ['loop1'] },
      loop1: { moduleId: 'base.loop', props: { sourceId: 'data.rows' }, children: [] },
    })
    const html = renderNode(
      'root',
      projectionCtx(page, { annotateNodeIds: undefined }),
      makeAccumulators(),
    )
    expect(html).toContain('uid="root"')
    expect(html).toContain('uid="loop1"')
  })

  it('annotates every element with uid and includes hidden nodes', () => {
    const page = makePage({
      root: { moduleId: 'base.container', children: ['a', 'b'] },
      a: { moduleId: 'base.text', props: { text: 'Visible' } },
      b: { moduleId: 'base.text', props: { text: 'Ghost' }, hidden: true },
    })
    const projection = renderNode('root', projectionCtx(page), makeAccumulators())
    expect(projection).toContain('uid="root"')
    expect(projection).toContain('uid="a"')
    expect(projection).toContain('uid="b"')
    expect(projection).toContain('Ghost')

    const publish = renderNode('root', publishCtx(page), makeAccumulators())
    expect(publish).not.toContain('Ghost')
  })

  it('never emits locked/label metadata into the HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: 'Hello' },
        locked: true,
        label: 'My Special Label',
      },
    })
    const html = renderNode('root', projectionCtx(page), makeAccumulators())
    expect(html).not.toContain('locked')
    expect(html).not.toContain('My Special Label')
    expect(html).not.toContain('hidden')
  })
})

// ---------------------------------------------------------------------------
// Loop template
// ---------------------------------------------------------------------------

describe('projection — base.loop', () => {
  const loopPage = () =>
    makePage({
      root: { moduleId: 'base.container', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: {
          sourceId: 'data.rows',
          filters: { tableId: 'tbl_1' },
          orderBy: 'publishedAt',
          direction: 'desc',
          limit: 6,
          offset: 0,
          pagination: 'none',
          pageSize: 10,
        },
        children: ['item'],
      },
      item: { moduleId: 'base.text', props: { text: '{currentEntry.title}' } },
    })

  it('emits <instatic-loop> with source attributes and the template rendered once', () => {
    const loopData = new Map([
      ['loop1', {
        items: [
          { id: 'r1', fields: { title: 'One' } },
          { id: 'r2', fields: { title: 'Two' } },
          { id: 'r3', fields: { title: 'Three' } },
        ],
        totalItems: 3,
        pageNumber: 1,
        hasMore: false,
      }],
    ])

    // Publish: three interpolated iterations.
    const publish = renderNode('root', publishCtx(loopPage(), { loopData }), makeAccumulators())
    expect(publish).toContain('One')
    expect(publish).toContain('Three')

    // Projection: one template, tokens intact, marker tag with source config.
    const projection = renderNode('root', projectionCtx(loopPage(), { loopData }), makeAccumulators())
    expect(projection).toContain('<instatic-loop')
    expect(projection).toContain('data-source-id="data.rows"')
    expect(projection).toContain('data-table-id="tbl_1"')
    expect(projection).toContain('data-order-by="publishedAt"')
    expect(projection).toContain('data-limit="6"')
    expect(projection).toContain('uid="loop1"')
    expect(projection).toContain('uid="item"')
    const occurrences = projection.split('{currentEntry.title}').length - 1
    expect(occurrences).toBe(1)
    expect(projection).not.toContain('One')
    expect(projection).toContain('</instatic-loop>')
  })

  it('renders every variant exactly once with a multi-variant loop', () => {
    const page = makePage({
      root: { moduleId: 'base.container', children: ['loop1'] },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'data.rows' },
        children: ['variantA', 'variantB'],
      },
      variantA: { moduleId: 'base.text', props: { text: 'Variant A {currentEntry.title}' } },
      variantB: { moduleId: 'base.text', props: { text: 'Variant B {currentEntry.title}' } },
    })
    const projection = renderNode('root', projectionCtx(page), makeAccumulators())
    expect(projection.split('Variant A').length - 1).toBe(1)
    expect(projection.split('Variant B').length - 1).toBe(1)
    expect(projection.indexOf('Variant A')).toBeLessThan(projection.indexOf('Variant B'))
  })

  it('emits author htmlAttributes on the loop marker, tokens verbatim', () => {
    const page = makePage({
      root: {
        moduleId: 'base.loop',
        props: {
          sourceId: 'data.rows',
          htmlAttributes: { 'aria-label': '{currentEntry.title}', role: 'list' },
        },
        children: [],
      },
    })
    const projection = renderNode('root', projectionCtx(page), makeAccumulators())
    expect(projection).toContain('aria-label="{currentEntry.title}"')
    expect(projection).toContain('role="list"')
  })

  it('renders the template even with no resolved loop data', () => {
    const projection = renderNode('root', projectionCtx(loopPage()), makeAccumulators())
    expect(projection).toContain('<instatic-loop')
    expect(projection).toContain('{currentEntry.title}')
    expect(projection).not.toContain('no resolved data')
  })
})

// ---------------------------------------------------------------------------
// Visual Component ref + slots
// ---------------------------------------------------------------------------

const cardVC: VisualComponent = {
  id: 'vc-card',
  name: 'Pricing Card',
  createdAt: 0,
  params: [],
  tree: {
    rootNodeId: 'vc-root',
    nodes: {
      'vc-root': {
        id: 'vc-root',
        moduleId: 'base.container',
        props: {},
        breakpointOverrides: {},
        children: ['vc-secret'],
        classIds: [],
      },
      'vc-secret': {
        id: 'vc-secret',
        moduleId: 'base.text',
        props: { text: 'Internal VC markup' },
        breakpointOverrides: {},
        children: [],
        classIds: [],
      },
    },
  },
}

describe('projection — base.visual-component-ref and slots', () => {
  it('emits an opaque <instatic-component> with editable <instatic-slot> fills', () => {
    const page = makePage({
      root: { moduleId: 'base.container', children: ['ref1'] },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-card' },
        children: ['slot1'],
      },
      slot1: {
        moduleId: 'base.slot-instance',
        props: { slotName: 'content' },
        children: ['fill'],
      },
      fill: { moduleId: 'base.text', props: { text: 'User slot content' } },
    })
    const site = makeSite({ visualComponents: [cardVC] })

    const projection = renderNode('root', projectionCtx(page, { site }), makeAccumulators())
    expect(projection).toContain('<instatic-component')
    expect(projection).toContain('data-component-id="vc-card"')
    expect(projection).toContain('data-component-name="Pricing Card"')
    expect(projection).toContain('uid="ref1"')
    // Internals stay opaque.
    expect(projection).not.toContain('Internal VC markup')
    // Slot fill is editable content.
    expect(projection).toContain('<instatic-slot ')
    expect(projection).toContain('data-slot-name="content"')
    expect(projection).toContain('uid="slot1"')
    expect(projection).toContain('User slot content')
    expect(projection).toContain('uid="fill"')

    // Publish expands the VC as before.
    const publish = renderNode('root', publishCtx(page, { site }), makeAccumulators())
    expect(publish).toContain('Internal VC markup')
    expect(publish).not.toContain('<instatic-component')
  })

  it('emits <instatic-slot-outlet> for slot outlets in a definition tree', () => {
    // A VC definition projected as a virtual page (VC canvas mode).
    const page = makePage({
      root: { moduleId: 'base.container', children: ['outlet1'] },
      outlet1: {
        moduleId: 'base.slot-outlet',
        props: { slotName: 'content' },
        children: ['fallback'],
      },
      fallback: { moduleId: 'base.text', props: { text: 'Default slot content' } },
    })
    const projection = renderNode('root', projectionCtx(page), makeAccumulators())
    expect(projection).toContain('<instatic-slot-outlet')
    expect(projection).toContain('data-slot-name="content"')
    expect(projection).toContain('uid="outlet1"')
    expect(projection).toContain('Default slot content')
  })

  it('emits <instatic-outlet> for the template content outlet', () => {
    const page = makePage({
      root: { moduleId: 'base.outlet', props: { tag: 'custom', customTag: 'section' } },
    })
    const projection = renderNode('root', projectionCtx(page), makeAccumulators())
    expect(projection).toContain('<instatic-outlet')
    expect(projection).toContain('data-custom-tag="section"')
    expect(projection).toContain('uid="root"')
  })
})

// ---------------------------------------------------------------------------
// Mixed tree — locks the full dialect in one exact-output assertion
// ---------------------------------------------------------------------------

describe('projection — mixed tree', () => {
  it('renders a page mixing text, loop, VC ref, slot fill, and a hidden node', () => {
    const page = makePage({
      root: { moduleId: 'base.container', children: ['intro', 'loop1', 'ref1', 'ghost'] },
      intro: { moduleId: 'base.text', props: { text: 'Welcome to {site.name}' } },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'data.rows', filters: { tableId: 'tbl_1' }, limit: 3 },
        children: ['loopItem'],
      },
      loopItem: { moduleId: 'base.text', props: { text: '{currentEntry.title}' } },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-card' },
        children: ['slot1'],
      },
      slot1: {
        moduleId: 'base.slot-instance',
        props: { slotName: 'content' },
        children: ['fill'],
      },
      fill: { moduleId: 'base.text', props: { text: 'Fill' } },
      ghost: { moduleId: 'base.text', props: { text: 'Ghost' }, hidden: true, locked: true },
    })
    const site = makeSite({ visualComponents: [cardVC] })

    const html = renderNode('root', projectionCtx(page, { site }), makeAccumulators())
    expect(html).toBe(
      '<div uid="root">' +
        '<p uid="intro">Welcome to {site.name}</p>' +
        '<instatic-loop uid="loop1" data-source-id="data.rows" data-table-id="tbl_1" data-limit="3">' +
          '<p uid="loopItem">{currentEntry.title}</p>' +
        '</instatic-loop>' +
        '<instatic-component uid="ref1" data-component-id="vc-card" data-component-name="Pricing Card">' +
          '<instatic-slot uid="slot1" data-slot-name="content">' +
            '<p uid="fill">Fill</p>' +
          '</instatic-slot>' +
        '</instatic-component>' +
        '<p uid="ghost">Ghost</p>' +
      '</div>',
    )
  })
})

// ---------------------------------------------------------------------------
// Publish output unchanged
// ---------------------------------------------------------------------------

describe('projection — publish path untouched', () => {
  it('projection:false renders the full mixed tree byte-identically to a no-flag render', () => {
    // Exercises every forked code path: loop with resolved data, VC ref with
    // slot fill, hidden node, tokens with a template context.
    const page = makePage({
      root: { moduleId: 'base.container', children: ['intro', 'loop1', 'ref1', 'ghost'] },
      intro: { moduleId: 'base.text', props: { text: '{currentEntry.title}' } },
      loop1: {
        moduleId: 'base.loop',
        props: { sourceId: 'data.rows' },
        children: ['loopItem'],
      },
      loopItem: { moduleId: 'base.text', props: { text: '{currentEntry.title}' } },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-card' },
        children: ['slot1'],
      },
      slot1: { moduleId: 'base.slot-instance', props: { slotName: 'content' }, children: ['fill'] },
      fill: { moduleId: 'base.text', props: { text: 'Fill' } },
      ghost: { moduleId: 'base.text', props: { text: 'Ghost' }, hidden: true },
    })
    const site = makeSite({ visualComponents: [cardVC] })
    const loopData = new Map([
      ['loop1', {
        items: [{ id: 'r1', fields: { title: 'One' } }],
        totalItems: 1,
        pageNumber: 1,
        hasMore: false,
      }],
    ])
    const shared = {
      site,
      loopData,
      templateContext: { entryStack: [ENTRY] },
    }
    const off = renderNode(
      'root',
      publishCtx(page, { ...shared, projection: false }),
      makeAccumulators(),
    )
    const none = renderNode('root', publishCtx(page, shared), makeAccumulators())
    expect(off).toBe(none)
    expect(off).toContain('Internal VC markup')
    expect(off).not.toContain('Ghost')
    expect(off).not.toContain('<instatic-')
  })
})
