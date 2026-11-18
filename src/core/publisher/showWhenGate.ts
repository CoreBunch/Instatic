/**
 * The show-when rules a node sits under, found by following the page the way
 * the renderer does.
 *
 * Rendering a page top-down applies each rule as the walk reaches it. An
 * endpoint that renders ONE node on request (a hole, more items of a loop)
 * starts in the middle, so it must check the rules above its starting point
 * itself. Otherwise a child of an element limited to members could be fetched
 * directly by anyone who knows its id.
 *
 * "Above" is the render path, not the page's own node map:
 *  - a node inside a Visual Component is under the component's own nodes AND
 *    under the reference that placed it on the page;
 *  - content dropped into a component's slot is under the slot outlet's
 *    ancestors inside the component.
 *  - a page is rendered inside the site-wide layouts, at their outlet, so it
 *    is under whatever is above the outlet there.
 * A node can be reached by several paths (a component used twice). Each path
 * is returned separately: the node is rendered for a visitor if at least one
 * path lets them through, which is exactly where they would see it.
 */
import { readShowWhen, showWhenAllows, type ShowWhen, type ShowWhenVisitor } from '@core/members'
import { selectVisualComponentById, type Page, type SiteDocument } from '@core/page-tree'
import { firstOutletId, resolveTemplateChain } from '@core/templates'

type Rule = ShowWhen | 'nobody'

interface WalkNode {
  id: string
  moduleId: string
  props: Record<string, unknown>
  children: string[]
  propBindings?: Record<string, unknown>
}

const VC_REF = 'base.visual-component-ref'
const SLOT_INSTANCE = 'base.slot-instance'
const SLOT_OUTLET = 'base.slot-outlet'

function slotName(node: WalkNode): string {
  return typeof node.props.slotName === 'string' ? node.props.slotName : 'children'
}

/**
 * Every render path from the page's root to `nodeId`, as the list of
 * show-when rules met on the way (the node's own rule included when
 * `includeSelf`). An empty result means the node is not rendered anywhere on
 * this page; callers must treat that as "nobody", never as "no rules".
 */
export function showWhenPathsTo(
  page: Page,
  site: SiteDocument,
  nodeId: string,
  options: { includeSelf: boolean },
): Rule[][] {
  const paths: Rule[][] = []

  const visit = (
    nodes: Record<string, WalkNode>,
    currentId: string,
    above: readonly Rule[],
    seenComponents: ReadonlySet<string>,
    /** Slot name → rules above that slot's outlet, for the component being walked. */
    outlets: Map<string, readonly Rule[]> | null,
  ): void => {
    const node = nodes[currentId]
    if (!node) return
    // A rule bound to a component parameter takes its value per placement,
    // which this walk does not work out. Such a node is given to nobody here
    // rather than read with the unbound value.
    const own = node.propBindings && 'showWhen' in node.propBindings ? 'nobody' : readShowWhen(node.props)
    const withOwn = own === null ? above : [...above, own]
    if (node.id === nodeId) paths.push(options.includeSelf ? [...withOwn] : [...above])

    if (node.moduleId === SLOT_OUTLET && outlets) outlets.set(slotName(node), withOwn)

    if (node.moduleId === VC_REF) {
      const componentId = typeof node.props.componentId === 'string' ? node.props.componentId : ''
      const component = componentId && !seenComponents.has(componentId) ? selectVisualComponentById(site, componentId) : undefined
      const componentOutlets = new Map<string, readonly Rule[]>()
      if (component) {
        visit(
          component.tree.nodes as Record<string, WalkNode>,
          component.tree.rootNodeId,
          withOwn,
          new Set(seenComponents).add(componentId),
          componentOutlets,
        )
      }
      // Slot fills are children of the reference on the page, but they render
      // where the component puts the matching outlet. A fill with no outlet
      // is not rendered at all.
      for (const childId of node.children) {
        const child = nodes[childId]
        if (child?.moduleId === SLOT_INSTANCE) {
          const outletRules = componentOutlets.get(slotName(child))
          visit(nodes, childId, outletRules ?? [...withOwn, 'nobody'], seenComponents, outlets)
        } else {
          visit(nodes, childId, withOwn, seenComponents, outlets)
        }
      }
      return
    }

    for (const childId of node.children) visit(nodes, childId, withOwn, seenComponents, outlets)
  }

  visit(page.nodes as Record<string, WalkNode>, page.rootNodeId, layoutRulesAbove(page, site), new Set(), null)
  return paths
}

/**
 * The rules a page's whole content sits under: those above the outlet of
 * each site-wide layout it is rendered inside. A site-wide layout itself is
 * the outermost tree and sits under nothing.
 */
function layoutRulesAbove(page: Page, site: SiteDocument): Rule[] {
  if (page.template?.enabled && page.template.target.kind === 'everywhere') return []
  const rules: Rule[] = []
  for (const layout of resolveTemplateChain(site, { kind: 'page' })) {
    const outletId = firstOutletId(layout.nodes)
    if (outletId === null || layout.id === page.id) continue
    const toOutlet = showWhenPathsTo(layout, site, outletId, { includeSelf: true })
    // An outlet the layout's own tree does not reach is never rendered.
    rules.push(...(toOutlet[0] ?? ['nobody']))
  }
  return rules
}

/** Does any render path to the node carry a show-when rule? Then it is rendered per visitor. */
export function showWhenPathsAreGated(paths: readonly Rule[][]): boolean {
  return paths.length === 0 || paths.some((rules) => rules.length > 0)
}

/** May this visitor (`null` when signed out) be given the node? */
export function showWhenPathsAllow(paths: readonly Rule[][], visitor: ShowWhenVisitor | null): boolean {
  return paths.some((rules) => rules.every((rule) => showWhenAllows(rule, visitor)))
}
