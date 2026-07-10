/**
 * nodeDisplayName — pure helpers that resolve display-only metadata of a
 * PageNode for the DOM tree, breadcrumbs, drag previews, and rename prompts.
 *
 * Three pieces of info live here so every consumer of the layers panel
 * (`TreeNode`, `useDomPanelDnd`, `CanvasRoot` rename flow) sees the same
 * resolution rules:
 *
 *   - getNodeDisplayName  → the user-facing label
 *   - getNodeHtmlTag       → the underlying HTML tag (or null)
 *   - getNodeClassNames    → the assigned CSS class names
 *
 * Display name resolution order (first non-empty wins):
 *   1. node.label                — explicit user-set label
 *   2. VC name (when node.moduleId === 'base.visual-component-ref' AND
 *      props.componentId resolves to a Visual Component in the site)
 *   3. definition.name           — module's display name from registry
 *   4. node.moduleId             — final fallback (registry miss)
 *
 * Step (2) is what makes a "componentized" node show up as "Header" in the
 * DOM tree instead of the generic "Component" label that the
 * base.visual-component-ref module declaration carries. Renaming the VC
 * automatically updates every ref in the tree (no per-ref node label sync).
 */

import type { PageNode } from './pageNode'
import type { VisualComponent } from '@core/visual-components-schema'
import { resolveHtmlTagBadge, type AnyModuleDefinition } from '@core/module-engine-schema'
import { classNamesForClassIds, type StyleRuleRegistry } from './classNames'
import { isDomNode } from './baseNode'

export function getNodeDisplayName(
  node: Pick<PageNode, 'label' | 'moduleId' | 'props' | 'tag'>,
  definition: AnyModuleDefinition | undefined,
  visualComponents: ReadonlyArray<VisualComponent> | undefined,
): string {
  if (node.label && node.label.length > 0) return node.label

  // DOM-native nodes: use the tag as the display name (e.g. "h1", "div")
  if (isDomNode(node)) return node.tag!

  if (node.moduleId === 'base.visual-component-ref') {
    const componentId = (node.props as Record<string, unknown> | undefined)?.componentId
    if (typeof componentId === 'string' && componentId.length > 0 && visualComponents) {
      const vc = visualComponents.find((v) => v.id === componentId)
      if (vc && vc.name.length > 0) return vc.name
    }
  }

  // slot-instance: show "Slot: <slotName>" so the DOM tree panel clearly identifies
  // which named slot this placeholder fills (e.g. "Slot: children", "Slot: actions").
  if (node.moduleId === 'base.slot-instance') {
    const props = node.props as Record<string, unknown> | undefined
    const slotName = typeof props?.slotName === 'string' && props.slotName ? props.slotName : 'children'
    return `Slot: ${slotName}`
  }

  return definition?.name ?? node.moduleId
}

/**
 * Resolve the HTML tag a module renders for the given props.
 *
 * For DOM-native nodes, returns the node's `tag` directly.
 *
 * Returns null when the module did not declare an `htmlTag` hint — that's the
 * signal to the layers panel to omit the `<tag>` badge for nodes that don't
 * emit a single deterministic root element (visual-component-ref, slot-outlet,
 * loop, etc.). Lowercased so display is consistent regardless of how a module
 * stores its tag prop.
 */
export function getNodeHtmlTag(
  node: Pick<PageNode, 'props' | 'moduleId' | 'tag'>,
  definition: AnyModuleDefinition | undefined,
): string | null {
  if (isDomNode(node)) return node.tag!
  return resolveHtmlTagBadge(definition, (node.props ?? {}) as Record<string, unknown>)
}

/**
 * Resolve the CSS class names assigned to a node, in declared order. Returns
 * an empty array when the node has no classIds or the registry can't resolve
 * any of them.
 */
export function getNodeClassNames(
  node: Pick<PageNode, 'classIds'>,
  classes: StyleRuleRegistry,
): string[] {
  return classNamesForClassIds(classes, node.classIds)
}
