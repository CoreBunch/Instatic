import type { BaseNode, PageNode } from '@core/page-tree-schema'
import type { VisualComponent } from './schemas'
import { instantiateVCAtRef } from './instantiate'
import { resolveSlotName, safePropOverrides } from './propGuards'

export interface RenderTreeFrame {
  readonly nodes: Readonly<Record<string, BaseNode>>
  readonly ancestors: readonly PageNode[]
}

/** Walk the materialized render tree, including effective VC params and slots. */
export function walkRenderTree(
  nodes: Readonly<Record<string, BaseNode>>,
  rootNodeId: string,
  components: readonly VisualComponent[],
  onNode: (node: PageNode, frame: RenderTreeFrame) => void,
): void {
  const byId = new Map(components.map((component) => [component.id, component]))
  const visit = (
    currentNodes: Readonly<Record<string, BaseNode>>,
    nodeId: string,
    seenComponents: ReadonlySet<string>,
    ancestors: ReadonlySet<string>,
    renderAncestors: readonly PageNode[],
  ): void => {
    const node = currentNodes[nodeId]
    if (!node || node.hidden || ancestors.has(nodeId)) return
    onNode(node, { nodes: currentNodes, ancestors: renderAncestors })
    const nextRenderAncestors = [...renderAncestors, node]
    if (node.moduleId === 'base.visual-component-ref') {
      const id = typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
      const component = byId.get(id)
      if (!component || seenComponents.has(id)) return
      const slots: Record<string, string[]> = {}
      for (const childId of node.children) {
        const child = currentNodes[childId]
        if (child?.moduleId === 'base.slot-instance') slots[resolveSlotName(child.props)] = child.children
      }
      const tree = instantiateVCAtRef(component, safePropOverrides(node.props), slots, currentNodes, node.id)
      visit(tree.nodes, tree.rootNodeId, new Set(seenComponents).add(id), new Set(), nextRenderAncestors)
      return
    }
    const nextAncestors = new Set(ancestors).add(nodeId)
    for (const childId of node.children) visit(currentNodes, childId, seenComponents, nextAncestors, nextRenderAncestors)
  }
  visit(nodes, rootNodeId, new Set(), new Set(), [])
}
