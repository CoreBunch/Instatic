// ---------------------------------------------------------------------------
// Barrel — the canonical public API for the page-tree module.
//
// Everything outside `src/core/page-tree/` MUST import from `@core/page-tree`.
// Direct deep imports (`@core/page-tree/<file>`) are reserved for internal
// cross-references within the module itself — they exist so internal files
// don't go through the barrel and create import cycles. CLAUDE.md documents
// this pattern.
// ---------------------------------------------------------------------------

// Schemas — exported as both runtime constants (for parse/compiled validation)
// and types (via Static<typeof X>).
export { BaseNodeSchema,  parseBaseNodeFields } from './baseNode'
export { asPlainObject } from './parseHelpers'
export { NodeTreeSchema } from './treeSchema'
export { PageNodeSchema, parsePageNode } from './pageNode'
export {
  TreeOperationSchema,
  TreeMutateResultSchema,
  assertValidNodeTree,
  parsePageNodeTree,
} from './operationSchema'
export { PageSchema } from './page'
export {
  StyleRuleSchema,
  classKindSelector,
  classifySelectorCreateInput,
  parseStyleRule,
} from './styleRule'
export { SiteShellSchema } from './siteDocument'
export {   parsePageTemplate } from './pageTemplate'

// Types — derived from schemas. Schemas are the source of truth.
export type { Breakpoint } from './breakpoint'
export type { DynamicPropBinding } from './dynamicBinding'
export type { PageTemplateConfig, TemplateTarget } from './pageTemplate'
export type { PageNode } from './pageNode'
export type { TreeOperation, TreeMutateResult } from './operationSchema'
export type { Page } from './page'
export type { CSSPropertyBag } from './cssPropertyBag'
export type { SelectorCreateInput, StyleRule, StyleRuleKind } from './styleRule'
export type { Condition, ConditionDef } from './condition'
export type { SiteSettings } from './siteSettings'
export type { SiteShell, SiteDocument } from './siteDocument'
export type {
  DecorativeSiteExplorerSectionId,
  SiteExplorerFolder,
  SiteExplorerItemPlacement,
  SiteExplorerSectionId,
  StructuralExplorerRowOrder,
  StructuralExplorerSection,
  StructuralSiteExplorerSectionId,
} from './siteExplorer'

// Defaults
export { DEFAULT_BREAKPOINTS, breakpointMediaQuery, defaultBreakpointMediaQuery } from './breakpoint'
export { DEFAULT_SITE_SETTINGS } from './siteSettings'

// Condition helpers
export { conditionId, conditionLabel, makeConditionDef, parseConditions } from './condition'

// Tolerant parsers — boundary helpers for persisted data.
export { parseBreakpoint } from './breakpoint'
export { parsePage } from './page'
export { parseSiteDocument } from './siteDocument'
export {
  SITE_EXPLORER_SECTION_IDS,
  createDefaultSiteExplorerOrganization,
  createExplorerFolder,
  deleteExplorerFolder,
  moveExplorerFolder,
  moveExplorerItem,
  moveExplorerItems,
  parseSiteExplorerOrganization,
  reconcileSiteExplorerInPlace,
  reconcileSiteExplorerOrganization,
  renameExplorerFolder,
  wrapExplorerItemsInFolder,
} from './siteExplorer'
export {
  buildDeleteExplorerPathPlan,
  buildMoveExplorerFolderPlan,
  buildMoveExplorerItemPlan,
  buildRenameExplorerFolderPlan,
  commitExplorerPathPlan,
  type ExplorerPathChangePlan,
} from './explorerPathPlans'

// Slug → public path + internal page-reference links.
export {
  normalizePageSlug,
  pageSlugError,
  pageSlugDuplicateError,
  createUniquePageSlug,
  pagePublicPath,
  isHomePage,
  findHomePage,
} from './slugs'
export {
  makePageRef,
  isPageRef,
  parsePageRef,
  resolvePageRef,
} from './pageRef'

// Other re-exports unrelated to the schemas split


export type { BaseNode } from './baseNode'

export type { NodeTree } from './treeSchema'

export {
  createNode,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNode,
  moveNodes,
  duplicateNode,
  buildSubtreeNodeIdMap,
  pasteSubtree,
  wrapNode,
  wrapNodes,
  applyTreeOperation,
} from './mutations'

export {
  addPage,
  deletePage,
  renamePage,
  reorderPages,
  duplicatePage,
} from './pageMutations'

export { reindexNodeParents } from './parentIndex'

export { removeNodeSubtrees, deleteSubtree } from './subtreeRemoval'

export { cloneNodeWithRemap } from './cloneNode'

export { cloneScopedClassesForNodeMap } from './scopedClassClone'

export {
  getNode,
  getNodeOrThrow,
  getChildren,
  getParent,
  getAncestors,
  flattenSubtree,
  collectSubtreeIds,
  isAncestor,
  resolveProps,
  evaluateCondition,
} from './selectors'

export {
  assertValidCssClassName,
  styleRuleSelector,
  classNamesForClassIds,
} from './classNames'
export type { StyleRuleRegistry } from './classNames'

export {
  isUserVisibleClass,
  isGeneratedClass,
  isGeneratedClassLocked,
  generatedClassKindLabel,
} from './classUtils'

export { getNodeDisplayName, getNodeHtmlTag, getNodeClassNames } from './nodeDisplayName'

export { resolvePageTreeDropTarget } from './dnd'
export type { PageTreeDropPosition, PageTreeDropTarget } from './dnd'

export {
  selectVisualComponentById,
} from './siteSelectors'

export {
  compareStructuralRows,
  sameStructuralParent,
  structuralRowKey,
  structuralRowsForSection,
} from './structuralRows'
export type { StructuralExplorerRow } from './structuralRows'
export { parentPathForPath } from './explorerPaths'
