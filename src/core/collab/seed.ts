/**
 * Doc seeding — deterministic construction of a collab doc from persisted
 * domain JSON. The SERVER is the only seeder (fixed `SEED_CLIENT_ID`), so
 * two clients can never build divergent initial histories for the same
 * content — the classic double-seed duplication pitfall.
 *
 * Page/VC meta stores authored fields only; server-owned row metadata
 * (owner/created-by/updated-by) never enters the doc — the persist layer
 * preserves it on the row.
 */
import * as Y from 'yjs'
import type { Page, SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { dataMap, metaMap, rostersMap, SEED_CLIENT_ID, SEED_ORIGIN, SHELL_PER_ENTRY_KEYS, shellMap, treeMap } from './schema'
import { buildNodeMap } from './nodeY'
import { buildSiteFilesMap } from './filesY'
import type { SiteFile } from '@core/files/schemas'

function seeding(doc: Y.Doc, fn: () => void): void {
  const previousClientId = doc.clientID
  doc.clientID = SEED_CLIENT_ID
  try {
    doc.transact(fn, SEED_ORIGIN)
  } finally {
    doc.clientID = previousClientId
  }
}

function seedTree(
  doc: Y.Doc,
  tree: { rootNodeId: string; nodes: Record<string, Page['nodes'][string]> },
): void {
  const t = treeMap(doc)
  t.set('rootNodeId', tree.rootNodeId)
  const nodes = new Y.Map<unknown>()
  t.set('nodes', nodes)
  for (const [id, node] of Object.entries(tree.nodes)) {
    nodes.set(id, buildNodeMap(node))
  }
}

/** Page-owned meta fields — everything on `Page` that is not the tree or server-owned. */
const PAGE_SERVER_OWNED = new Set(['ownerUserId', 'createdByUserId', 'updatedByUserId'])

/**
 * populate* — write a row's full content into its doc WITHOUT owning the
 * transaction. Two callers: the server seeder below (SEED origin, fixed
 * clientID) and the patch translator (client-created rows, LOCAL origin —
 * brand-new content has exactly one author, so no double-seed risk).
 */
export function populatePageDoc(doc: Y.Doc, page: Page): void {
  const meta = metaMap(doc)
  for (const [key, value] of Object.entries(page)) {
    if (key === 'nodes' || key === 'rootNodeId' || key === 'id') continue
    if (PAGE_SERVER_OWNED.has(key) || value === undefined) continue
    meta.set(key, value)
  }
  seedTree(doc, page)
}

export function populateComponentDoc(doc: Y.Doc, vc: VisualComponent): void {
  const meta = metaMap(doc)
  for (const [key, value] of Object.entries(vc)) {
    if (key === 'tree' || key === 'id' || value === undefined) continue
    meta.set(key, value)
  }
  seedTree(doc, vc.tree)
}

export function populateLayoutDoc(doc: Y.Doc, layout: SavedLayout): void {
  const { id: _id, name, createdAt, ...snapshot } = layout
  const meta = metaMap(doc)
  meta.set('name', name)
  meta.set('createdAt', createdAt)
  // Whole-snapshot LWW — layouts have save/rename/delete semantics, not
  // node-level co-editing.
  dataMap(doc).set('snapshot', snapshot)
}

export function seedPageDoc(doc: Y.Doc, page: Page): void {
  seeding(doc, () => populatePageDoc(doc, page))
}

export function seedComponentDoc(doc: Y.Doc, vc: VisualComponent): void {
  seeding(doc, () => populateComponentDoc(doc, vc))
}

export function seedLayoutDoc(doc: Y.Doc, layout: SavedLayout): void {
  seeding(doc, () => populateLayoutDoc(doc, layout))
}

/** Shell keys stored as per-entry Y.Maps (granular co-editing); the rest are plain LWW values. */
const SHELL_SKIPPED_KEYS = new Set(['pages', 'visualComponents', 'layouts', 'id', 'updatedAt'])

export interface SiteDocRosterIds {
  pages: readonly string[]
  components: readonly string[]
  layouts: readonly string[]
}

/**
 * Seed the site doc from a shell + roster ids — the server relay's entry
 * (it has the shell row and lean id projections, never a hydrated
 * SiteDocument). `seedSiteDoc` below is the full-document convenience used
 * by clients/tests that already hold one.
 */
export function seedSiteDocFromParts(
  doc: Y.Doc,
  shellFields: Record<string, unknown>,
  rosterIds: SiteDocRosterIds,
): void {
  seeding(doc, () => {
    const shell = shellMap(doc)
    for (const [key, value] of Object.entries(shellFields)) {
      if (SHELL_SKIPPED_KEYS.has(key) || value === undefined) continue
      if (key === 'files' && Array.isArray(value)) {
        // Per-file granular layout — entry Y.Maps with Y.Text content, so
        // two admins can co-edit code files character-by-character.
        shell.set('files', buildSiteFilesMap(value as SiteFile[]))
        continue
      }
      if (SHELL_PER_ENTRY_KEYS.has(key)) {
        const entryMap = new Y.Map<unknown>()
        for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
          if (entryValue !== undefined) entryMap.set(entryKey, entryValue)
        }
        shell.set(key, entryMap)
      } else {
        shell.set(key, value)
      }
    }

    const rosters = rostersMap(doc)
    const pages = new Y.Map<unknown>()
    for (const id of rosterIds.pages) pages.set(id, true)
    rosters.set('pages', pages)
    const order = new Y.Array<string>()
    order.push([...rosterIds.pages])
    rosters.set('pageOrder', order)
    const components = new Y.Map<unknown>()
    for (const id of rosterIds.components) components.set(id, true)
    rosters.set('components', components)
    const layouts = new Y.Map<unknown>()
    for (const id of rosterIds.layouts) layouts.set(id, true)
    rosters.set('layouts', layouts)
  })
}

export function seedSiteDoc(doc: Y.Doc, site: SiteDocument): void {
  const { pages, visualComponents, layouts, ...shellFields } = site
  seedSiteDocFromParts(doc, shellFields, {
    pages: pages.map((p) => p.id),
    components: visualComponents.map((vc) => vc.id),
    layouts: layouts.map((l) => l.id),
  })
}
