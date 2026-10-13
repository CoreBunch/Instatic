/**
 * Page-tree schema/type leaf.
 *
 * This is the acyclic public surface for page-tree primitives: node schemas,
 * tree shapes, tolerant parsers, and tree-local helpers that do not depend on
 * SiteDocument, visual components, layouts, publisher, or the module registry.
 */

export {
  BaseNodeSchema,
  parseBaseNodeFields,
} from '../page-tree/baseNode'
export type { BaseNode } from '../page-tree/baseNode'

export { asPlainObject } from '../page-tree/parseHelpers'

export { NodeTreeSchema } from '../page-tree/treeSchema'
export type { NodeTree } from '../page-tree/treeSchema'

export {
  PageNodeSchema,
  parsePageNode,
} from '../page-tree/pageNode'
export type { PageNode } from '../page-tree/pageNode'

export { PageSchema, parsePage } from '../page-tree/page'
export type { Page } from '../page-tree/page'

export {
  StyleRuleSchema,
  parseStyleRule,
} from '../page-tree/styleRule'
export type { StyleRule } from '../page-tree/styleRule'

export { ConditionDefSchema, parseConditions } from '../page-tree/condition'
export type { ConditionDef } from '../page-tree/condition'

export { reindexNodeParents } from '../page-tree/parentIndex'
export {
  collectSubtreeIds,
  getAncestors,
  getChildren,
  getNode,
  getNodeOrThrow,
  getParent,
  isAncestor,
} from '../page-tree/selectors'
export { deleteSubtree, removeNodeSubtrees } from '../page-tree/subtreeRemoval'

export { DynamicPropBindingSchema } from '../page-tree/dynamicBinding'
export type { DynamicPropBinding } from '../page-tree/dynamicBinding'
