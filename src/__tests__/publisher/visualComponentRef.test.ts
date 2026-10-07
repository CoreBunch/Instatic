/**
 * Publisher VC inlining tests — Phase 5 slice 2a.
 *
 * Tests the renderVisualComponentRef() path in render.ts that intercepts
 * base.visual-component-ref nodes and inlines the instantiated VC tree.
 *
 * Coverage:
 *  1. Inlining with prop override
 *  2. Slot expansion (with content / with defaultValue / without either)
 *  3. Class CSS collection for VC node classIds
 *  4. Unknown componentId → HTML comment
 *  5. RichText override sanitization
 *  6. Nested VC refs (recursive inlining)
 */

import { describe, it, expect } from 'bun:test'
import { publishPage, renderNode } from '@core/publisher'
import type { VisualComponent, VCParam, VCNode } from '@core/visualComponents'
import { makeModule, makeRegistry, makePage, makeSite, makeAccumulators } from './helpers'
import { ContainerModule } from '@modules/base/container'
import { TextModule } from '@modules/base/text'
import { VisualComponentRefModule } from '@modules/base/visualComponentRef'
import { SlotOutletModule } from '@modules/base/slotOutlet'
import { OutletModule } from '@modules/base/outlet'

// ---------------------------------------------------------------------------
// Shared registry including all modules used by VCs under test
// ---------------------------------------------------------------------------

const registry = makeRegistry({
  'base.container': ContainerModule as never,
  'base.text': TextModule as never,
  'base.visual-component-ref': VisualComponentRefModule as never,
  'base.slot-outlet': SlotOutletModule as never,
  'base.outlet': OutletModule as never,
})

// ---------------------------------------------------------------------------
// VC fixture helpers
// ---------------------------------------------------------------------------

function makeParam(overrides: Partial<VCParam> & { id: string; name: string; type: VCParam['type'] }): VCParam {
  return {
    defaultValue: '',
    required: false,
    ...overrides,
  }
}

function makeVCNode(overrides: Partial<VCNode> & { id: string; moduleId: string }): VCNode {
  return {
    props: {},
    breakpointOverrides: {},
    children: [],
    classIds: [],
    ...overrides,
  }
}

/** Build a VisualComponent with a flat tree from an array of all nodes + root ID. */
function makeVC(overrides: {
  id: string
  name: string
  nodes: VCNode[]
  rootId: string
  params?: VCParam[]
  classIds?: string[]
}): VisualComponent {
  const nodesMap: Record<string, VCNode> = {}
  for (const n of overrides.nodes) nodesMap[n.id] = n
  return {
    params: overrides.params ?? [],
    breakpoints: [],
    classIds: overrides.classIds ?? [],
    createdAt: 0,
    id: overrides.id,
    name: overrides.name,
    tree: { nodes: nodesMap, rootNodeId: overrides.rootId },
  }
}

// ---------------------------------------------------------------------------
// 1. Inlining with prop override
// ---------------------------------------------------------------------------

describe('VC inlining — prop override substitution', () => {
  // VC: <div><p>{title}</p></div>  where `title` is a param (id: 'param-title')
  const textNode = makeVCNode({
    id: 'vc-text',
    moduleId: 'base.text',
    props: { text: 'Default Title', tag: 'p' },
    propBindings: { text: { paramId: 'param-title' } },
  })
  const containerNode = makeVCNode({
    id: 'vc-root',
    moduleId: 'base.container',
    children: ['vc-text'],
  })
  const vc = makeVC({
    id: 'vc-card',
    name: 'Card',
    nodes: [containerNode, textNode],
    rootId: 'vc-root',
    params: [makeParam({ id: 'param-title', name: 'title', type: 'string', defaultValue: 'Default Title' })],
  })

  it('inlines the VC tree and substitutes the prop override', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-card',
          propOverrides: { 'param-title': 'Override Title' },
        },
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('Override Title')
    expect(html).not.toContain('Default Title')
  })

  it('uses the param defaultValue when no override is provided', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-card',
          propOverrides: {},
        },
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('Default Title')
  })

  it('emits the VC root element in the published HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-card',
          propOverrides: { 'param-title': 'Hello' },
          slotContent: {},
        },
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })
    const { html } = publishPage(page, site, registry)
    // Container renders as <div>, text renders as <p>
    expect(html).toContain('<div>')
    expect(html).toContain('<p>Hello</p>')
  })
})

// ---------------------------------------------------------------------------
// 2. Slot expansion
// ---------------------------------------------------------------------------

describe('VC inlining — slot expansion', () => {
  // VC: <div>[slot: children]</div>
  const slotOutletNode = makeVCNode({
    id: 'vc-slot-outlet',
    moduleId: 'base.slot-outlet',
    props: { slotName: 'children' },
  })
  const slotContainerNode = makeVCNode({
    id: 'vc-slot-root',
    moduleId: 'base.container',
    children: ['vc-slot-outlet'],
  })

  // Default slot content for when no instance content is provided
  const defaultSlotNode = makeVCNode({
    id: 'default-slot-text',
    moduleId: 'base.text',
    props: { text: 'Default slot content', tag: 'p' },
  })

  const vcWithSlot = makeVC({
    id: 'vc-slot',
    name: 'SlotComponent',
    nodes: [slotContainerNode, slotOutletNode],
    rootId: 'vc-slot-root',
    params: [makeParam({
      id: 'param-children',
      name: 'children',
      type: 'slot',
      defaultValue: [defaultSlotNode] as unknown,
    })],
  })

  it('expands slot with provided slot-instance content (Task 4 Tree Unification)', () => {
    // Instance slot content: a slot-instance child of the VC ref + content node.
    // The VC ref node's children include a base.slot-instance node (locked, slotName='children')
    // whose children are the user-authored content nodes.
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-slot',
          propOverrides: {},
        },
        children: ['slot-inst-children'],
      },
      'slot-inst-children': {
        moduleId: 'base.slot-instance',
        props: { slotName: 'children' },
        children: ['slot-content-text'],
        locked: true,
      },
      'slot-content-text': {
        moduleId: 'base.text',
        props: { text: 'Instance slot content', tag: 'p' },
      },
    })
    const site = makeSite({ visualComponents: [vcWithSlot], pages: [page] })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('Instance slot content')
    expect(html).not.toContain('Default slot content')
  })

  it('uses slot param defaultValue when no slotContent is provided', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-slot',
          propOverrides: {},
        },
      },
    })
    const site = makeSite({ visualComponents: [vcWithSlot], pages: [page] })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('Default slot content')
  })

  it('preserves native dynamic bindings and inline styles on page-authored slot fills', () => {
    const page = makePage({
      root: { moduleId: 'base.visual-component-ref', props: { componentId: 'vc-slot' }, children: ['slot'] },
      slot: { moduleId: 'base.slot-instance', props: { slotName: 'children' }, children: ['fill'] },
      fill: {
        moduleId: 'base.text', props: { text: 'Static placeholder', tag: 'p' },
        dynamicBindings: { text: { source: 'page', field: 'title' } },
        inlineStyles: { color: 'red' },
      },
    })
    page.title = 'Bound slot title'
    const { html } = publishPage(page, makeSite({ visualComponents: [vcWithSlot], pages: [page] }), registry)
    expect(html).toContain('Bound slot title')
    expect(html).toContain('color: red')
    expect(html).not.toContain('Static placeholder')
    expect(html).not.toContain('Default slot content')
  })

  it('does not expose filled or default content of a hidden slot outlet', () => {
    const hidden = makeVC({ id: 'hidden-slot', name: 'HiddenSlot', rootId: 'vc-slot-root',
      nodes: [slotContainerNode, { ...slotOutletNode, hidden: true }], params: vcWithSlot.params })
    const page = makePage({
      root: { moduleId: 'base.visual-component-ref', props: { componentId: 'hidden-slot' }, children: ['slot'] },
      slot: { moduleId: 'base.slot-instance', props: { slotName: 'children' }, children: ['fill'] },
      fill: { moduleId: 'base.text', props: { text: 'Hidden fill', tag: 'p' } },
    })
    const site = makeSite({ visualComponents: [hidden], pages: [page] })
    expect(publishPage(page, site, registry).html).not.toContain('Hidden fill')
    page.nodes.root!.children = []
    expect(publishPage(page, site, registry).html).not.toContain('Default slot content')
  })

  it('emits empty string for slot-outlet with no content and no defaultValue', () => {
    // VC with a slot outlet that has NO defaultValue
    const vcNoDefault = makeVC({
      id: 'vc-no-default',
      name: 'NoDefault',
      nodes: [slotContainerNode, slotOutletNode],
      rootId: 'vc-slot-root',
      params: [makeParam({
        id: 'param-empty',
        name: 'children',
        type: 'slot',
        defaultValue: [],
      })],
    })
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-no-default',
          propOverrides: {},
        },
      },
    })
    const site = makeSite({ visualComponents: [vcNoDefault], pages: [page] })
    const { html } = publishPage(page, site, registry)
    // The slot-outlet renders as empty string (no content, no default)
    // The container div is present but empty
    expect(html).toContain('<div></div>')
    // No slot comment markers or placeholder text
    expect(html).not.toContain('slotOutlet')
    expect(html).not.toContain('<!-- ')
  })
})

describe('VC inlining — hidden nodes', () => {
  it('omits hidden nodes from a Visual Component definition', () => {
    const visibleText = makeVCNode({
      id: 'vc-visible-text',
      moduleId: 'base.text',
      props: { text: 'Visible VC text', tag: 'p' },
    })
    const hiddenText = makeVCNode({
      id: 'vc-hidden-text',
      moduleId: 'base.text',
      props: { text: 'Hidden VC text', tag: 'p' },
      hidden: true,
    })
    const container = makeVCNode({
      id: 'vc-hidden-root',
      moduleId: 'base.container',
      children: ['vc-visible-text', 'vc-hidden-text'],
    })
    const vc = makeVC({
      id: 'vc-hidden',
      name: 'Hidden Nodes',
      nodes: [container, visibleText, hiddenText],
      rootId: 'vc-hidden-root',
    })
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-hidden', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })

    const { html } = publishPage(page, site, registry)

    expect(html).toContain('Visible VC text')
    expect(html).not.toContain('Hidden VC text')
  })

  it('omits hidden slot-fill nodes from slot outlet output', () => {
    const slotOutletNode = makeVCNode({
      id: 'hidden-slot-outlet',
      moduleId: 'base.slot-outlet',
      props: { slotName: 'children' },
    })
    const container = makeVCNode({
      id: 'hidden-slot-root',
      moduleId: 'base.container',
      children: ['hidden-slot-outlet'],
    })
    const vc = makeVC({
      id: 'vc-hidden-slot',
      name: 'Hidden Slot',
      nodes: [container, slotOutletNode],
      rootId: 'hidden-slot-root',
      params: [makeParam({
        id: 'param-children',
        name: 'children',
        type: 'slot',
        defaultValue: [],
      })],
    })
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-hidden-slot', propOverrides: {} },
        children: ['slot-inst'],
      },
      'slot-inst': {
        moduleId: 'base.slot-instance',
        props: { slotName: 'children' },
        children: ['shown-slot-text', 'hidden-slot-text'],
        locked: true,
      },
      'shown-slot-text': {
        moduleId: 'base.text',
        props: { text: 'Shown slot text', tag: 'p' },
      },
      'hidden-slot-text': {
        moduleId: 'base.text',
        props: { text: 'Hidden slot text', tag: 'p' },
        hidden: true,
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })

    const { html } = publishPage(page, site, registry)

    expect(html).toContain('Shown slot text')
    expect(html).not.toContain('Hidden slot text')
  })
})

// ---------------------------------------------------------------------------
// 3. Class CSS — VC node classIds included in CSS bundle
// ---------------------------------------------------------------------------

describe('VC inlining — class CSS collection', () => {
  it('CSS class rules for VC node classIds appear in published output', () => {
    // VC text node has a classId referencing a CSS class
    const textNode = makeVCNode({
      id: 'vc-cls-text',
      moduleId: 'base.text',
      props: { text: 'Styled', tag: 'p' },
      classIds: ['cls-heading'],
    })
    const rootNode = makeVCNode({
      id: 'vc-cls-root',
      moduleId: 'base.container',
      children: ['vc-cls-text'],
    })
    const vc = makeVC({ id: 'vc-cls', name: 'Cls', nodes: [rootNode, textNode], rootId: 'vc-cls-root' })

    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-cls', propOverrides: {} },
      },
    })
    const site = makeSite({
      visualComponents: [vc],
      pages: [page],
      styleRules: {
        'cls-heading': {
          id: 'cls-heading',
          name: 'heading-xl',
          kind: 'class',
          selector: '.heading-xl',
          order: 0,
          styles: { fontSize: '2rem' },
          contextStyles: {},
          createdAt: 0,
          updatedAt: 0,
        },
      },
    })

    const { html } = publishPage(page, site, registry)
    // The class name appears in the HTML (injected onto the text element)
    expect(html).toContain('heading-xl')
    // The CSS rule for the class appears in the <style> block
    expect(html).toContain('font-size')
  })

  it('CSS dedup: VC used twice — both instances render, shared cssMap used', () => {
    // Use a custom module that returns CSS so we can verify dedup
    const withCssRegistry = makeRegistry({
      'base.visual-component-ref': VisualComponentRefModule as never,
      'base.slot-outlet': SlotOutletModule as never,
      'test.styled': makeModule('test.styled', {
        render: (props) => ({
          html: `<p>${String((props as { text: unknown }).text)}</p>`,
          css: 'p { color: navy; }',
        }),
      }),
      'base.container': ContainerModule as never,
    })

    const styledNode = makeVCNode({
      id: 'vc-dedup-styled',
      moduleId: 'test.styled',
      props: { text: 'Styled' },
    })
    const dedupRoot = makeVCNode({
      id: 'vc-dedup-root',
      moduleId: 'base.container',
      children: ['vc-dedup-styled'],
    })
    const vc = makeVC({ id: 'vc-dedup', name: 'Dedup', nodes: [dedupRoot, styledNode], rootId: 'vc-dedup-root' })

    // Two ref nodes pointing at the same VC
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: {},
        children: ['ref1', 'ref2'],
      },
      ref1: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-dedup', propOverrides: {} },
      },
      ref2: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-dedup', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [vc], pages: [page] })
    const acc = makeAccumulators()
    const html = renderNode(
      'root',
      { page, site, registry: withCssRegistry, breakpointId: undefined },
      acc,
    )

    // Both instances of the VC appear in the HTML
    expect(html.match(/<p>Styled<\/p>/g)?.length).toBe(2)
    // But the CSS rule is deduplicated — only one entry for the module type.
    // The shared acc.cssMap is what dedups across the VC boundary: both ref
    // nodes inline the same module, yet it contributes CSS exactly once.
    expect(acc.cssMap.has('test.styled')).toBe(true)
    expect(acc.cssMap.size).toBe(1) // only test.styled has CSS; base.container returns none
    // And the CSS appears exactly once (not duplicated)
    const cssCount = (acc.cssMap.get('test.styled') ?? '').split('p { color: navy; }').length - 1
    expect(cssCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Unknown componentId
// ---------------------------------------------------------------------------

describe('VC inlining — unknown componentId', () => {
  it('emits an HTML comment for a non-existent componentId', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'nonexistent-vc', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [], pages: [page] })
    const html = renderNode(
      'root',
      { page, site, registry, breakpointId: undefined },
      makeAccumulators(),
    )
    expect(html).toContain('<!-- instatic: unknown component')
    expect(html).toContain('nonexistent-vc')
    expect(html).not.toContain('<div>')
  })

  it('emits a missing-componentId comment when componentId is empty', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: '', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [], pages: [page] })
    const html = renderNode(
      'root',
      { page, site, registry, breakpointId: undefined },
      makeAccumulators(),
    )
    expect(html).toContain('<!-- instatic: visual-component-ref missing componentId -->')
  })

  it('HTML-escapes the componentId in the error comment to prevent XSS', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: '<script>evil</script>', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [], pages: [page] })
    const html = renderNode(
      'root',
      { page, site, registry, breakpointId: undefined },
      makeAccumulators(),
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// 5. RichText override sanitization
// ---------------------------------------------------------------------------

describe('VC inlining — richtext prop sanitization', () => {
  // VC: <main>{html param}</main> using base.outlet (html is a richtext key)
  const contentNode = makeVCNode({
    id: 'vc-content-node',
    moduleId: 'base.outlet',
    props: { tag: 'main', html: '' },
    propBindings: { html: { paramId: 'param-html' } },
  })
  const contentRootNode = makeVCNode({
    id: 'vc-content-root',
    moduleId: 'base.container',
    children: ['vc-content-node'],
  })
  const vcContent = makeVC({
    id: 'vc-richtext',
    name: 'RichTextVC',
    nodes: [contentRootNode, contentNode],
    rootId: 'vc-content-root',
    params: [makeParam({ id: 'param-html', name: 'html', type: 'richText', defaultValue: '' })],
  })

  it('strips <script> from richtext param override, preserves safe HTML', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-richtext',
          propOverrides: { 'param-html': '<p>ok</p><script>bad()</script>' },
        },
      },
    })
    const site = makeSite({ visualComponents: [vcContent], pages: [page] })
    const { html } = publishPage(page, site, registry)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('bad()')
    // Safe text content must be preserved
    expect(html).toContain('ok')
  })

  it('sanitized richtext does not break the surrounding HTML structure', () => {
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: {
          componentId: 'vc-richtext',
          propOverrides: { 'param-html': '<p>text</p><script>x()</script>' },
        },
      },
    })
    const site = makeSite({ visualComponents: [vcContent], pages: [page] })
    const { html } = publishPage(page, site, registry)
    // The <main> wrapper from base.outlet must be intact (the
    // `data-instatic-content-region` attribute is the marker the content
    // editor's Live mode uses to mount its inline Tiptap instance).
    expect(html).toContain('<main data-instatic-content-region>')
    expect(html).not.toContain('<script>')
  })
})

// ---------------------------------------------------------------------------
// 6. Nested VC refs (recursive inlining)
// ---------------------------------------------------------------------------

describe('VC inlining — nested VC refs', () => {
  it('recursively inlines a VC that contains another VC ref', () => {
    // Inner VC: <p>Inner</p>
    const innerTextNode = makeVCNode({
      id: 'inner-text',
      moduleId: 'base.text',
      props: { text: 'Inner', tag: 'p' },
    })
    const innerVC = makeVC({
      id: 'vc-inner',
      name: 'InnerCard',
      nodes: [innerTextNode],
      rootId: 'inner-text',
    })

    // Outer VC: <div>[ref to inner VC]</div>
    const refNode = makeVCNode({
      id: 'outer-ref',
      moduleId: 'base.visual-component-ref',
      props: { componentId: 'vc-inner', propOverrides: {} },
    })
    const outerRootNode = makeVCNode({
      id: 'outer-root',
      moduleId: 'base.container',
      children: ['outer-ref'],
    })
    const outerVC = makeVC({
      id: 'vc-outer',
      name: 'OuterCard',
      nodes: [outerRootNode, refNode],
      rootId: 'outer-root',
    })

    // Page ref points to the outer VC
    const page = makePage({
      root: {
        moduleId: 'base.visual-component-ref',
        props: { componentId: 'vc-outer', propOverrides: {} },
      },
    })
    const site = makeSite({ visualComponents: [innerVC, outerVC], pages: [page] })
    const { html } = publishPage(page, site, registry)

    // Both levels must be inlined
    expect(html).toContain('Inner')
    // Structure: outer container wraps inner text
    expect(html).toContain('<div>')
    expect(html).toContain('<p>Inner</p>')
  })
})
