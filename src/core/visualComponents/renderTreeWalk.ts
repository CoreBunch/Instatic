import type { BaseNode, PageNode } from '@core/page-tree-schema'
import type { VisualComponent } from './schemas'
import { instantiateVCAtRef } from './instantiate'
import { resolveSlotName, safePropOverrides } from './propGuards'

export interface RenderTreeFrame {
  readonly nodes: Readonly<Record<string, BaseNode>>
  readonly ancestors: readonly PageNode[]
  readonly id: string
  readonly parentId: string | null
  readonly componentIds: ReadonlySet<string>
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
    prefix: string,
    parentId: string | null,
  ): void => {
    const node = currentNodes[nodeId]
    if (!node || node.hidden || ancestors.has(nodeId)) return
    const id = prefix + node.id
    onNode(node, { nodes: currentNodes, ancestors: renderAncestors, id, parentId, componentIds: seenComponents })
    const nextRenderAncestors = [...renderAncestors, node]
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
      const component = byId.get(componentId)
      if (!component || seenComponents.has(componentId)) return
      const slots: Record<string, string[]> = {}
      for (const childId of node.children) {
        const child = currentNodes[childId]
        if (child?.moduleId === 'base.slot-instance') slots[resolveSlotName(child.props)] = child.children
      }
      const tree = instantiateVCAtRef(component, safePropOverrides(node.props), slots, currentNodes, node.id)
      visit(tree.nodes, tree.rootNodeId, new Set(seenComponents).add(componentId), new Set(), nextRenderAncestors, id + ':', id)
      return
    }
    const nextAncestors = new Set(ancestors).add(nodeId)
    for (const childId of node.children) visit(currentNodes, childId, seenComponents, nextAncestors, nextRenderAncestors, prefix, id)
  }
  visit(nodes, rootNodeId, new Set(), new Set(), [], '', null)
}
