/**
 * vcVariantClasses.test.ts — class bindings (the VC variant channel).
 *
 * `propBindings` writes a param's value into `node.props`, which can never
 * change appearance because `class` is not a prop. `classBindings` is the
 * styling counterpart: paramId → (value → classId), resolved in
 * `instantiateVCAtRef` — the single choke point both the editor preview and
 * the publisher render through, so covering it here covers both.
 *
 * The resolved class must land in `classIds` (not as a raw class name) because
 * the publisher collects CSS from the classIds it walks: a variant reachable
 * only through a param would otherwise be tree-shaken out of the stylesheet.
 */

import { describe, it, expect } from 'bun:test'
import { instantiateVCAtRef } from '@core/visualComponents'
import type { VisualComponent, VCNode } from '@core/visualComponents'

function node(
  id: string,
  moduleId: string,
  opts: {
    classIds?: string[]
    classBindings?: Record<string, Record<string, string>>
    children?: string[]
  } = {},
): VCNode {
  return {
    id,
    moduleId,
    props: {},
    breakpointOverrides: {},
    children: opts.children ?? [],
    classIds: opts.classIds ?? [],
    ...(opts.classBindings ? { classBindings: opts.classBindings } : {}),
  }
}

function vc(nodes: VCNode[], rootId: string, params: VisualComponent['params'] = []): VisualComponent {
  const nodesMap: Record<string, VCNode> = {}
  for (const n of nodes) nodesMap[n.id] = n
  return {
    id: 'vc-button',
    name: 'Button',
    tree: { nodes: nodesMap, rootNodeId: rootId },
    params,
    classIds: [],
    createdAt: 1000,
  }
}

const VARIANT_PARAM: VisualComponent['params'] = [
  {
    id: 'p-variant',
    name: 'variant',
    type: 'enum',
    defaultValue: 'orange',
    required: false,
    enumOptions: ['orange', 'white', 'ghost'],
  },
]

const BUTTON = () =>
  node('root', 'base.link', {
    classIds: ['c-btn'],
    classBindings: {
      'p-variant': { orange: 'c-btn-orange', white: 'c-btn-white', ghost: 'c-btn-ghost' },
    },
  })

const REF_ID = 'page-ref'

describe('VC class bindings — variant selection', () => {
  it('appends the class mapped to the overridden param value', () => {
    const { nodes } = instantiateVCAtRef(
      vc([BUTTON()], 'root', VARIANT_PARAM),
      { 'p-variant': 'ghost' },
      {},
      {},
      REF_ID,
    )
    expect(nodes['root'].classIds).toEqual(['c-btn', 'c-btn-ghost'])
  })

  it("falls back to the param's defaultValue when the instance overrides nothing", () => {
    const { nodes } = instantiateVCAtRef(vc([BUTTON()], 'root', VARIANT_PARAM), {}, {}, {}, REF_ID)
    expect(nodes['root'].classIds).toEqual(['c-btn', 'c-btn-orange'])
  })

  it('keeps the base class first so the variant wins the cascade', () => {
    const { nodes } = instantiateVCAtRef(
      vc([BUTTON()], 'root', VARIANT_PARAM),
      { 'p-variant': 'white' },
      {},
      {},
      REF_ID,
    )
    expect(nodes['root'].classIds[0]).toBe('c-btn')
    expect(nodes['root'].classIds.at(-1)).toBe('c-btn-white')
  })

  it('adds no class for a value the map does not cover, so a "none" option works', () => {
    const component = vc([BUTTON()], 'root', [
      { ...VARIANT_PARAM[0]!, enumOptions: ['orange', 'plain'], defaultValue: 'plain' },
    ])
    const { nodes } = instantiateVCAtRef(component, { 'p-variant': 'plain' }, {}, {}, REF_ID)
    expect(nodes['root'].classIds).toEqual(['c-btn'])
  })

  it('ignores a non-string param value rather than emitting a bogus class', () => {
    const component = vc([BUTTON()], 'root', [
      { id: 'p-variant', name: 'variant', type: 'enum', defaultValue: 42, required: false },
    ])
    const { nodes } = instantiateVCAtRef(component, {}, {}, {}, REF_ID)
    expect(nodes['root'].classIds).toEqual(['c-btn'])
  })

  it('does not duplicate a class the node already carries', () => {
    const withDuplicate = node('root', 'base.link', {
      classIds: ['c-btn', 'c-btn-orange'],
      classBindings: { 'p-variant': { orange: 'c-btn-orange' } },
    })
    const { nodes } = instantiateVCAtRef(
      vc([withDuplicate], 'root', VARIANT_PARAM),
      { 'p-variant': 'orange' },
      {},
      {},
      REF_ID,
    )
    expect(nodes['root'].classIds).toEqual(['c-btn', 'c-btn-orange'])
  })

  it('resolves independent variant params on the same node', () => {
    const multi = node('root', 'base.link', {
      classIds: ['c-btn'],
      classBindings: {
        'p-variant': { ghost: 'c-btn-ghost' },
        'p-size': { lg: 'c-btn-lg' },
      },
    })
    const component = vc([multi], 'root', [
      ...VARIANT_PARAM,
      { id: 'p-size', name: 'size', type: 'enum', defaultValue: 'md', required: false, enumOptions: ['md', 'lg'] },
    ])
    const { nodes } = instantiateVCAtRef(
      component,
      { 'p-variant': 'ghost', 'p-size': 'lg' },
      {},
      {},
      REF_ID,
    )
    expect(nodes['root'].classIds).toEqual(['c-btn', 'c-btn-ghost', 'c-btn-lg'])
  })

  it('resolves bindings on a nested node, not just the root', () => {
    const child = node('icon', 'base.svg', {
      classIds: ['c-icon'],
      classBindings: { 'p-variant': { ghost: 'c-icon-dark' } },
    })
    const root = node('root', 'base.link', { classIds: ['c-btn'], children: ['icon'] })
    const { nodes } = instantiateVCAtRef(
      vc([root, child], 'root', VARIANT_PARAM),
      { 'p-variant': 'ghost' },
      {},
      {},
      REF_ID,
    )
    expect(nodes['icon'].classIds).toEqual(['c-icon', 'c-icon-dark'])
    expect(nodes['root'].classIds).toEqual(['c-btn'])
  })

  it('leaves classIds untouched on a node with no bindings', () => {
    const plain = node('root', 'base.link', { classIds: ['c-btn'] })
    const { nodes } = instantiateVCAtRef(vc([plain], 'root', VARIANT_PARAM), {}, {}, {}, REF_ID)
    expect(nodes['root'].classIds).toEqual(['c-btn'])
    expect(nodes['root'].classBindings).toBeUndefined()
  })
})
