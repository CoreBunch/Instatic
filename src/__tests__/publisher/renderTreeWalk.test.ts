import { describe, test, expect } from 'bun:test'
import type { BaseNode, PageNode } from '@core/page-tree'
import { walkRenderTree, type VisualComponent } from '@core/visualComponents'

/**
 * ISS-022: loop/media prefetch must descend into Visual Component definition
 * trees, otherwise a base.loop or image inside a VC body is never fetched and
 * renders with no data. The shared walker visits every node that actually
 * renders — page nodes AND nodes inside referenced VC trees — with a cycle
 * guard so a self-referencing VC can't loop forever.
 */
const n = (id: string, moduleId: string, children: string[] = [], props: Record<string, unknown> = {}): BaseNode =>
  ({ id, moduleId, props, children, breakpointOverrides: {}, classIds: [] })

function siteWith(vcs: Array<{ id: string; rootNodeId: string; nodes: Record<string, BaseNode> }>): { visualComponents: VisualComponent[] } {
  return {
    visualComponents: vcs.map((vc) => ({
      id: vc.id,
      name: vc.id,
      params: [],
      tree: { rootNodeId: vc.rootNodeId, nodes: vc.nodes },
      breakpoints: [],
      classIds: [],
      createdAt: 0,
    })),
  }
}

describe('walkRenderTree', () => {
  test('provides distinct instance ids and parent frames for repeated components', () => {
    const site = siteWith([{ id: 'shared', rootNodeId: 'control', nodes: { control: n('control', 'base.input') } }])
    const nodes = {
      root: n('root', 'base.body', ['first', 'second']),
      first: n('first', 'base.visual-component-ref', [], { componentId: 'shared' }),
      second: n('second', 'base.visual-component-ref', [], { componentId: 'shared' }),
    }
    const instances: { id: string; parentId: string | null; components: string[] }[] = []
    walkRenderTree(nodes, 'root', site.visualComponents, (node, frame) => {
      if (node.moduleId === 'base.input') instances.push({ id: frame.id, parentId: frame.parentId, components: [...frame.componentIds] })
    })
    expect(instances).toEqual([
      { id: 'first:control', parentId: 'first', components: ['shared'] },
      { id: 'second:control', parentId: 'second', components: ['shared'] },
    ])
  })
  test('descends into a referenced VC definition tree', () => {
    const site = siteWith([
      {
        id: 'vc1',
        rootNodeId: 'v1',
        nodes: {
          v1: n('v1', 'base.container', ['v1loop', 'v1img']),
          v1loop: n('v1loop', 'base.loop'),
          v1img: n('v1img', 'base.image', [], { src: '/uploads/x.png' }),
        },
      },
    ])
    const pageNodes: Record<string, BaseNode> = {
      root: n('root', 'base.body', ['ref']),
      ref: n('ref', 'base.visual-component-ref', [], { componentId: 'vc1' }),
    }
    const visited: string[] = []
    walkRenderTree(pageNodes, 'root', site.visualComponents, (node) => visited.push(node.id))
    expect(visited).toContain('v1loop')
    expect(visited).toContain('v1img')
  })

  test('terminates on a self-referencing VC cycle', () => {
    const site = siteWith([
      { id: 'vcA', rootNodeId: 'a', nodes: { a: n('a', 'base.visual-component-ref', [], { componentId: 'vcB' }) } },
      { id: 'vcB', rootNodeId: 'b', nodes: { b: n('b', 'base.visual-component-ref', [], { componentId: 'vcA' }) } },
    ])
    const pageNodes: Record<string, BaseNode> = {
      root: n('root', 'base.visual-component-ref', [], { componentId: 'vcA' }),
    }
    const visited: string[] = []
    walkRenderTree(pageNodes, 'root', site.visualComponents, (node) => visited.push(node.id))
    // Both VC bodies are visited exactly once; no infinite recursion.
    expect(visited.filter((id) => id === 'a')).toHaveLength(1)
    expect(visited.filter((id) => id === 'b')).toHaveLength(1)
  })

  test('visits effective overridden and default param values without mutating authored nodes', () => {
    const component = siteWith([{
      id: 'card', rootNodeId: 'image', nodes: { image: {
        ...n('image', 'base.image', [], { src: 'authored' }),
        propBindings: { src: { paramId: 'image-param' } },
      } },
    }]).visualComponents[0]!
    component.params = [{ id: 'image-param', name: 'image', type: 'string', required: false, defaultValue: '/default.png' }]
    const refs = {
      root: n('root', 'base.body', ['override', 'default']),
      override: n('override', 'base.visual-component-ref', [], { componentId: ' card ', propOverrides: { 'image-param': '/override.png' } }),
      default: n('default', 'base.visual-component-ref', [], { componentId: 'card', propOverrides: [] }),
    }
    const sources: unknown[] = []
    walkRenderTree(refs, 'root', [component], (node) => { if (node.moduleId === 'base.image') sources.push(node.props.src) })
    expect(sources).toEqual(['/override.png', '/default.png'])
    expect(component.tree.nodes.image!.props.src).toBe('authored')
    expect(refs.override.props.propOverrides).toEqual({ 'image-param': '/override.png' })
  })

  test('materializes filled slots once, includes nested refs, and omits unused defaults and fills', () => {
    const components = siteWith([
      { id: 'slots', rootNodeId: 'vc-root', nodes: {
        'vc-root': n('vc-root', 'base.container', ['outlet']),
        outlet: n('outlet', 'base.slot-outlet', [], { slotName: 'main' }),
      } },
      { id: 'nested', rootNodeId: 'nested-image', nodes: { 'nested-image': n('nested-image', 'base.image') } },
    ]).visualComponents
    components[0]!.params = [{ id: 'main-param', name: 'main', type: 'slot', required: false, defaultValue: [n('default', 'base.text')] }]
    const fill: PageNode = { ...n('fill', 'base.text'), dynamicBindings: { text: { source: 'page', field: 'title' } }, inlineStyles: { color: 'red' } }
    const nodes = {
      ref: n('ref', 'base.visual-component-ref', ['slot', 'unused-slot'], { componentId: 'slots' }),
      slot: n('slot', 'base.slot-instance', ['fill', 'nested-ref'], { slotName: 'main' }),
      fill,
      'nested-ref': n('nested-ref', 'base.visual-component-ref', [], { componentId: 'nested' }),
      'unused-slot': n('unused-slot', 'base.slot-instance', ['unused-fill'], { slotName: 'unused' }),
      'unused-fill': n('unused-fill', 'base.image'),
    }
    const visited: PageNode[] = []
    walkRenderTree(nodes, 'ref', components, (node) => visited.push(node))
    expect(visited.map((node) => node.id)).toEqual(['ref', 'vc-root', 'fill', 'nested-ref', 'nested-image'])
    expect(visited.find((node) => node.id === 'fill')!.dynamicBindings).toEqual(fill.dynamicBindings)
    expect(visited.find((node) => node.id === 'fill')!.inlineStyles).toEqual(fill.inlineStyles)
    const defaultNodes: string[] = []
    walkRenderTree({ ref: { ...nodes.ref, children: [] } }, 'ref', components, (node) => defaultNodes.push(node.id))
    expect(defaultNodes).toEqual(['ref', 'vc-root', 'default'])
  })

  test('skips hidden subtrees, orphan nodes, and fills of a hidden slot outlet', () => {
    const component = siteWith([{ id: 'hidden-slot', rootNodeId: 'vc-root', nodes: {
      'vc-root': n('vc-root', 'base.container', ['hidden-outlet', 'visible']),
      'hidden-outlet': { ...n('hidden-outlet', 'base.slot-outlet'), hidden: true },
      visible: n('visible', 'base.text'),
    } }]).visualComponents[0]!
    const nodes = {
      root: n('root', 'base.body', ['hidden-ref', 'ref']),
      'hidden-ref': { ...n('hidden-ref', 'base.visual-component-ref', [], { componentId: 'hidden-slot' }), hidden: true },
      ref: n('ref', 'base.visual-component-ref', ['slot'], { componentId: 'hidden-slot' }),
      slot: n('slot', 'base.slot-instance', ['fill']),
      fill: n('fill', 'base.image'),
      orphan: n('orphan', 'base.image'),
    }
    const visited: string[] = []
    walkRenderTree(nodes, 'root', [component], (node) => visited.push(node.id))
    expect(visited).toEqual(['root', 'ref', 'vc-root', 'visible'])
  })

  test('unknown refs do not expose raw slot children and ordinary node cycles terminate', () => {
    const nodes = {
      root: n('root', 'base.body', ['unknown', 'cycle']),
      unknown: n('unknown', 'base.visual-component-ref', ['slot'], { componentId: 'missing' }),
      slot: n('slot', 'base.slot-instance', ['fill']),
      fill: n('fill', 'base.image'),
      cycle: n('cycle', 'base.container', ['cycle']),
    }
    const visited: string[] = []
    walkRenderTree(nodes, 'root', [], (node) => visited.push(node.id))
    expect(visited).toEqual(['root', 'unknown', 'cycle'])
  })
})
