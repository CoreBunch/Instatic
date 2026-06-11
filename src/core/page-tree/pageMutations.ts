/**
 * Page-level mutations — called on a `SiteDocument` draft.
 *
 * Split from `mutations.ts` (which owns the tree-of-nodes engine): these
 * operate on the page ROSTER (add/delete/rename/reorder/duplicate), not on a
 * `NodeTree`. Same Mutative-draft calling convention; `duplicatePage` reuses
 * the node-clone primitives the tree engine shares.
 *
 * `deletePage` splices in place deliberately — a wholesale `pages` array
 * replacement emits a patch the editor's incremental save cannot attribute
 * to one page (see store slices/site/dirtyTracking.ts), forcing a full save.
 */
import { nanoid } from 'nanoid'
import type { Page } from './page'
import type { PageNode } from './pageNode'
import type { SiteDocument } from './siteDocument'
import { normalizePageSlug, uniquePageSlug } from './slugs'
import { cloneScopedClassesForNodeMap } from './scopedClassClone'
import { reindexNodeParents } from './parentIndex'
import { cloneNodeWithRemap } from './cloneNode'
import { createNode } from './mutations'


export function addPage(site: SiteDocument, title: string, slug: string): Page {
  const rootNode = createNode('base.body')
  const page: Page = {
    id: nanoid(),
    title,
    // Auto-unique so a repeated create (same title/slug) never collides — a
    // duplicate slug fails validateSite and bricks every save.
    slug: uniquePageSlug(slug, site.pages),
    rootNodeId: rootNode.id,
    nodes: { [rootNode.id]: rootNode },
  }
  site.pages.push(page)
  return page
}

export function deletePage(site: SiteDocument, pageId: string): void {
  if (site.pages.length <= 1) {
    throw new Error(`[PageTree] Cannot delete the last page in a site.`)
  }
  // Splice in place — never reassign the array (see module header).
  const index = site.pages.findIndex((p) => p.id === pageId)
  if (index !== -1) site.pages.splice(index, 1)
}

export function renamePage(site: SiteDocument, pageId: string, title: string, slug?: string): void {
  const page = site.pages.find((p) => p.id === pageId)
  if (!page) throw new Error(`[PageTree] Page "${pageId}" not found`)
  page.title = title
  if (slug !== undefined) {
    const normalized = normalizePageSlug(slug)
    // 'index' is the homepage intent — set it verbatim (homepage swap is a
    // separate concern). Any other slug is made unique against sibling pages
    // (excluding this one) so a rename can't introduce a duplicate slug.
    page.slug = normalized === 'index'
      ? 'index'
      : uniquePageSlug(slug, site.pages, pageId)
  }
}

export function reorderPages(site: SiteDocument, fromIndex: number, toIndex: number): void {
  const pages = site.pages
  const [moved] = pages.splice(fromIndex, 1)
  pages.splice(toIndex, 0, moved)
}

/**
 * Deep-clone a page (every node + its children, props, classIds,
 * breakpointOverrides) under a new title and slug. The cloned nodes get
 * fresh nanoid IDs so they don't collide with the source page. Returns
 * the new Page; caller is responsible for activating it if desired.
 *
 * Per-node "module-style" CSS classes (those with `scope.type === 'node'`)
 * are also cloned with fresh class ids and rewritten `scope.nodeId`s — the
 * publisher emits one CSS rule per class, so without this clone the new page
 * would silently share style entries with the source page (editing one would
 * restyle both). The newly cloned classes are written to `site.styleRules`.
 */
export function duplicatePage(
  site: SiteDocument,
  sourcePageId: string,
  title: string,
  slug?: string,
): Page {
  const source = site.pages.find((p) => p.id === sourcePageId)
  if (!source) throw new Error(`[PageTree] Page "${sourcePageId}" not found`)

  // Build a fresh-id map for every node in the source page.
  const idMap = new Map<string, string>()
  for (const oldId of Object.keys(source.nodes)) {
    idMap.set(oldId, nanoid())
  }

  // Clone every node-scoped class for nodes in the source page so the new
  // page gets its own scoped classes (with `scope.nodeId` pointing at the
  // duplicate's node ids). Non-scoped classes are shared and not cloned.
  const { added: clonedClasses, classIdRemap } = cloneScopedClassesForNodeMap(
    idMap,
    site.styleRules,
  )
  for (const cls of clonedClasses) {
    site.styleRules[cls.id] = cls
  }

  // Clone each node with remapped IDs, remapped child references, and
  // remapped scoped-class ids. Non-scoped classes (absent from classIdRemap)
  // are kept as-is — they're shared site-level classes that still exist.
  const remapClassId = (cid: string) => classIdRemap.get(cid) ?? cid
  const newNodes: Record<string, PageNode> = {}
  for (const [oldId, oldNode] of Object.entries(source.nodes)) {
    const newId = idMap.get(oldId)!
    newNodes[newId] = cloneNodeWithRemap(oldNode, { newId, idMap, classIdRemap: remapClassId })
  }

  const newRootId = idMap.get(source.rootNodeId)
  if (!newRootId) {
    throw new Error('[PageTree] Source page root node missing from page.nodes')
  }

  // Derive parentId for the cloned page from its (remapped) children arrays.
  reindexNodeParents(newNodes)

  const newPage: Page = {
    id: nanoid(),
    title,
    // Auto-unique — a duplicate ("Copy") must not collide with the source slug.
    slug: uniquePageSlug(slug ?? title, site.pages),
    rootNodeId: newRootId,
    nodes: newNodes,
  }
  site.pages.push(newPage)
  return newPage
}
