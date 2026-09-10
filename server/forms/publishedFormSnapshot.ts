/** Derive submission policy from the visible, composed language release. */
import { derivePageFormSnapshots, type PublicFormIdentity, type PublishedFormSnapshot } from '@core/forms'
import { reindexNodeParents, selectVisualComponentById, type Page, type PageNode, type SiteDocument } from '@core/page-tree'
import { instantiateVCAtRef, resolveSlotName, safePropOverrides } from '@core/visualComponents'
import { normalizeIdentifierValue } from '@core/utils/identifier'
import type { DbClient } from '../db/client'
import { getPublishVersion } from '../publish/publishState'
import { getPublishedRouteInventoryForVersion } from '../publish/publishedRoutes'
import { readPublishedRouteContext } from '../publish/publishedRouteContext'

export async function findPublishedFormSnapshot(db: DbClient, identity: PublicFormIdentity): Promise<PublishedFormSnapshot | null> {
  const inventory = await getPublishedRouteInventoryForVersion(db, getPublishVersion())
  const route = inventory.byPath.get(identity.pagePath)
  if (!route || route.contentId !== identity.pageId || route.localeId !== identity.localeId
    || route.publishedVersionId !== identity.publishedVersionId) return null
  const context = await readPublishedRouteContext(db, route, inventory)
  if (!context) return null
  return derivePageFormSnapshots(materializeFormTree(context.page, context.snapshot.site))
    .find((form) => form.formId === identity.formId) ?? null
}

/** Unique traversal keys keep separate component instances and slot fills apart. */
function materializeFormTree(page: Page, site: SiteDocument): Page {
  const nodes: Record<string, PageNode> = {}
  let nextId = 0
  function visit(tree: Page, id: string, seen: ReadonlySet<string>, components: ReadonlySet<string>): string | null {
    const node = tree.nodes[id]
    if (!node || node.hidden || seen.has(id)) return null
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = typeof node.props.componentId === 'string' ? node.props.componentId : ''
      const component = selectVisualComponentById(site, componentId)
      if (!component || components.has(componentId)) return null
      const slots: Record<string, string[]> = {}
      for (const childId of node.children) {
        const child = tree.nodes[childId]
        if (child?.moduleId === 'base.slot-instance' && !child.hidden) slots[resolveSlotName(child.props)] = child.children
      }
      const expanded = instantiateVCAtRef(component, safePropOverrides(node.props), slots, tree.nodes, node.id)
      return visit({ ...page, nodes: expanded.nodes, rootNodeId: expanded.rootNodeId }, expanded.rootNodeId,
        new Set(), new Set(components).add(componentId))
    }
    const key = `form-node-${nextId++}`
    const props = { ...node.props }
    if (node.moduleId === 'base.form') {
      props.formId = normalizeIdentifierValue(typeof props.formId === 'string' ? props.formId : node.id,
        normalizeIdentifierValue(node.id, 'form'))
    }
    const children = node.children.flatMap((childId) => {
      const child = visit(tree, childId, new Set(seen).add(id), components)
      return child ? [child] : []
    })
    nodes[key] = { ...node, id: key, props, children }
    return key
  }
  const rootNodeId = visit(page, page.rootNodeId, new Set(), new Set()) ?? ''
  reindexNodeParents(nodes)
  return { ...page, rootNodeId, nodes }
}
