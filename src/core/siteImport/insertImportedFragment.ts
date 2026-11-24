import type { ImportFragment } from '@core/htmlImport'
import { registry } from '@core/module-engine'
import {
  addMissingConditions, createStyleRuleOrderAllocator, reindexNodeParents,
  type ConditionDef, type NodeTree, type PageNode, type SiteShell,
} from '@core/page-tree'
import { indexStyleRulesByName, linkImportedClassNames, mergeImportedStyleRules } from './importLinking'
import type { NewStyleRule } from './types'

export interface FragmentInsertOptions {
  index?: number
  styleRules?: NewStyleRule[]
  conditions?: ConditionDef[]
}

/** Insert an HTML import into a mutable page or component and its site shell. */
export function insertImportedFragment(
  tree: NodeTree<PageNode>, site: SiteShell, parentId: string,
  fragment: ImportFragment, options: FragmentInsertOptions = {},
): boolean {
  const parent = Object.hasOwn(tree.nodes, parentId) && tree.nodes[parentId]
  if (!fragment.rootIds.length || !parent) return false
  if (parentId !== tree.rootNodeId && !registry.get(parent.moduleId)?.canHaveChildren) return false

  // Register the stylesheet before resolving HTML class names to registry IDs.
  const byName = indexStyleRulesByName(site.styleRules)
  const allocate = createStyleRuleOrderAllocator(site.styleRules)
  mergeImportedStyleRules(options.styleRules ?? [], site.styleRules, byName, allocate)
  addMissingConditions(site, options.conditions ?? [])
  for (const node of Object.values(fragment.nodes)) {
    tree.nodes[node.id] = { ...node, classIds: linkImportedClassNames(node.classIds, site.styleRules, byName, allocate) }
  }
  parent.children.splice(options.index ?? parent.children.length, 0, ...fragment.rootIds)
  reindexNodeParents(tree.nodes)
  return true
}
