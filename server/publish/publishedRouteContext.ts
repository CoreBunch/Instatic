import { reindexNodeParents, selectVisualComponentById, type Page, type PageNode, type SiteDocument } from '@core/page-tree'
import { instantiateVCAtRef, resolveSlotName, safePropOverrides } from '@core/visualComponents'
import type { PublishedDataRow } from '@core/data/schemas'
import { readSnapshotLanguage, type PublishedRoute, type PublishedRouteInventory } from '@core/localization-routing'
import { composeTemplateChain, isTemplatePage, resolveTemplateChain } from '@core/templates'
import { getPublishedDataRowById } from '../repositories/data'
import { getLatestPublishedSiteSnapshot, getPublishedPageSnapshotById, type PublishedPageSnapshot } from '../repositories/publish'
import type { DbClient } from '../db/client'
import { getPublishVersion, registerVersionedCacheReset } from './publishState'
import { snapshotForEntryRoute } from './entryTemplateSnapshot'

export interface PublishedRouteContext {
  route: PublishedRoute
  snapshot: PublishedPageSnapshot
  page: Page
  row?: PublishedDataRow
}

/** Follow the actual rendered tree, including localized component instances. */
export function findPublishedFragmentTarget(page: Page, site: SiteDocument, nodeId: string): { page: Page; node: PageNode } | null {
  function visit(tree: Page, id: string, seen: ReadonlySet<string>, components: ReadonlySet<string>): { page: Page; node: PageNode } | null {
    if (seen.has(id)) return null
    const node = tree.nodes[id]
    if (!node || node.hidden) return null
    if (id === nodeId) return { page: tree, node }
    const nextSeen = new Set(seen).add(id)
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = typeof node.props.componentId === 'string' ? node.props.componentId : ''
      const component = selectVisualComponentById(site, componentId)
      if (!component || components.has(componentId)) return null
      const slots: Record<string, string[]> = {}
      for (const childId of node.children) {
        const child = tree.nodes[childId]
        if (child?.moduleId === 'base.slot-instance') slots[resolveSlotName(child.props)] = child.children
      }
      const instantiated = instantiateVCAtRef(component, safePropOverrides(node.props), slots, tree.nodes, node.id)
      const nodes: Record<string, PageNode> = Object.fromEntries(Object.entries(instantiated.nodes).map(([key, value]) => [key, { ...value }]))
      reindexNodeParents(nodes)
      return visit({ ...page, nodes, rootNodeId: instantiated.rootNodeId }, instantiated.rootNodeId, new Set(), new Set(components).add(componentId))
    }
    for (const childId of node.children) {
      const result = visit(tree, childId, nextSeen, components)
      if (result) return result
    }
    return null
  }
  return visit(page, page.rootNodeId, new Set(), new Set())
}

/** Filter every navigation and internal reference through the live inventory. */
export function projectPublishedSite(site: SiteDocument, inventory: PublishedRouteInventory, localeId: string): SiteDocument {
  const locale = site.locales?.find((entry) => entry.id === localeId) ?? inventory.locales.find((entry) => entry.id === localeId)
  const language = readSnapshotLanguage(localeId, site.locales, site.settings.language)
  return {
    ...site,
    localeId,
    locales: site.locales ?? (locale ? [{ ...locale, ...language }] : []),
    settings: { ...site.settings, language: language.code },
    pages: [
      ...site.pages.filter(isTemplatePage),
      ...inventory.routes.filter((route) => route.kind === 'page' && route.localeId === localeId).map((route) => {
        const frozen = site.pages.find((page) => page.id === route.contentId)
        return { ...(frozen ?? { id: route.contentId, nodes: {}, rootNodeId: '' }),
          title: route.title ?? frozen?.title ?? '', slug: route.slug ?? frozen?.slug ?? '', publicPath: route.path }
      }),
    ],
  }
}

let contextCaches = new WeakMap<DbClient, { version: number; entries: Map<string, Promise<PublishedRouteContext | null>>; sites: Map<string, SiteDocument> }>()
registerVersionedCacheReset(() => { contextCaches = new WeakMap() })

/** The same locale and frozen template release is used for pages and fragments. */
export async function readPublishedRouteContext(
  db: DbClient, route: PublishedRoute, inventory: PublishedRouteInventory,
): Promise<PublishedRouteContext | null> {
  const version = getPublishVersion()
  let cache = contextCaches.get(db)
  if (!cache || cache.version !== version) {
    cache = { version, entries: new Map(), sites: new Map() }
    contextCaches.set(db, cache)
  }
  const key = JSON.stringify([route.localeId, route.contentId, route.publishedVersionId, route.path])
  let pending = cache.entries.get(key)
  if (!pending) {
    pending = loadPublishedRouteContext(db, route, inventory, cache.sites).catch((err) => { cache.entries.delete(key); throw err })
    cache.entries.set(key, pending)
  }
  return pending
}

async function loadPublishedRouteContext(
  db: DbClient, route: PublishedRoute, inventory: PublishedRouteInventory, sites: Map<string, SiteDocument>,
): Promise<PublishedRouteContext | null> {
  function project(snapshot: PublishedPageSnapshot): SiteDocument {
    const key = JSON.stringify([route.localeId, snapshot.siteSnapshotId ?? snapshot.versionId])
    let site = sites.get(key)
    if (!site) { site = projectPublishedSite(snapshot.site, inventory, route.localeId); sites.set(key, site) }
    return site
  }
  if (route.kind === 'page') {
    const snapshot = await getPublishedPageSnapshotById(db, route.contentId, route.localeId, route.siteSnapshotId)
    if (!snapshot || snapshot.versionId !== route.publishedVersionId) return null
    const site = project(snapshot)
    const source = site.pages.find((page) => page.id === route.contentId)
    if (!source || isTemplatePage(source)) return null
    const page = composeTemplateChain(resolveTemplateChain(site, { kind: 'page' }), { kind: 'page', page: source })
    return { route, snapshot: { ...snapshot, site }, page }
  }
  const row = await getPublishedDataRowById(db, route.contentId, route.localeId)
  if (!row || row.id !== route.publishedVersionId) return null
  const siteSnapshot = await getLatestPublishedSiteSnapshot(db, route.localeId, row.siteSnapshotId ?? undefined)
  if (!siteSnapshot) return null
  const site = project(siteSnapshot)
  const chain = resolveTemplateChain(site, { kind: 'entry', tableSlug: row.tableSlug })
  if (chain.length === 0) return null
  const snapshot = await snapshotForEntryRoute(db, { ...siteSnapshot, site }, row.tableSlug)
  const page = composeTemplateChain(chain, { kind: 'entry' })
  page.publicPath = route.path
  if (typeof row.cells.title === 'string') page.title = row.cells.title
  return { route, snapshot, page, row }
}
