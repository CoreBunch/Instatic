/**
 * Projection — the ONLY reader of collab Y state. Turns a doc back into the
 * domain JSON the editor store, the persist layer, and the publisher inputs
 * consume. Runs the deterministic integrity/roster reconciles so every peer
 * projects an identical, invariant-respecting document from converged state.
 */
import * as Y from 'yjs'
import type { BaseNode, Page, PageNode } from '@core/page-tree'
import { reindexNodeParents } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { dataMap, metaMap, rostersMap, shellMap, treeMap } from './schema'
import { own, projectNodeMap } from './nodeY'
import { projectSiteFilesValue } from './filesY'
import { reconcileTreeIntegrity } from './integrity'

function projectTree(doc: Y.Doc): { rootNodeId: string; nodes: Record<string, BaseNode> } {
  const t = treeMap(doc)
  const rootNodeId = typeof t.get('rootNodeId') === 'string' ? (t.get('rootNodeId') as string) : ''
  const nodesMap = t.get('nodes')
  const nodes: Record<string, BaseNode> = {}
  if (nodesMap instanceof Y.Map) {
    for (const [id, nodeMap] of nodesMap.entries()) {
      if (nodeMap instanceof Y.Map) nodes[id] = projectNodeMap(nodeMap)
    }
  }
  reconcileTreeIntegrity(nodes, rootNodeId)
  reindexNodeParents(nodes)
  return { rootNodeId, nodes }
}

function projectMeta(doc: Y.Doc): Record<string, unknown> {
  const meta: Record<string, unknown> = {}
  for (const [key, value] of metaMap(doc).entries()) meta[key] = own(value)
  return meta
}

export function projectPageDoc(doc: Y.Doc, rowId: string): Page {
  const { rootNodeId, nodes } = projectTree(doc)
  return {
    ...projectMeta(doc),
    id: rowId,
    rootNodeId,
    nodes: nodes as Record<string, PageNode>,
  } as Page
}

export function projectComponentDoc(doc: Y.Doc, rowId: string): VisualComponent {
  const { rootNodeId, nodes } = projectTree(doc)
  return {
    ...projectMeta(doc),
    id: rowId,
    tree: { rootNodeId, nodes },
  } as VisualComponent
}

export function projectLayoutDoc(doc: Y.Doc, rowId: string): SavedLayout {
  const meta = projectMeta(doc)
  const snapshot = own(dataMap(doc).get('snapshot'))
  const snapshotFields =
    snapshot && typeof snapshot === 'object' ? (snapshot as Record<string, unknown>) : {}
  return {
    ...snapshotFields,
    id: rowId,
    name: typeof meta.name === 'string' ? meta.name : '',
    createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
  } as SavedLayout
}

export interface ProjectedSiteDoc {
  /** Every shell field the doc holds (name, settings, styleRules, …) — no rows. */
  shell: Record<string, unknown>
  rosters: { pages: string[]; components: string[]; layouts: string[] }
}

function rosterIds(rosters: Y.Map<unknown>, key: string): Set<string> {
  const map = rosters.get(key)
  return map instanceof Y.Map ? new Set(map.keys()) : new Set()
}

export function projectSiteDoc(doc: Y.Doc): ProjectedSiteDoc {
  const shellSrc = shellMap(doc)
  const shell: Record<string, unknown> = {}
  for (const [key, value] of shellSrc.entries()) {
    // `files` is a granular map (one entry per file, content as Y.Text) so
    // the Plugin IDE can co-edit a file character-level; everything else in
    // the shell projects as an owned deep copy.
    if (key === 'files') {
      shell[key] = projectSiteFilesValue(value)
      continue
    }
    if (value instanceof Y.Map) {
      const entries: Record<string, unknown> = {}
      for (const [entryKey, entryValue] of value.entries()) entries[entryKey] = own(entryValue)
      shell[key] = entries
    } else {
      shell[key] = own(value)
    }
  }

  const rosters = rostersMap(doc)
  const pageMembers = rosterIds(rosters, 'pages')
  const orderSrc = rosters.get('pageOrder')
  const rawOrder = orderSrc instanceof Y.Array ? (orderSrc.toArray() as string[]) : []
  // Roster-order reconcile: dedupe, drop non-members, append missing members
  // (sorted for determinism) — mirrors the tree-integrity philosophy.
  const seen = new Set<string>()
  const pages: string[] = []
  for (const id of rawOrder) {
    if (!pageMembers.has(id) || seen.has(id)) continue
    seen.add(id)
    pages.push(id)
  }
  pages.push(...[...pageMembers].filter((id) => !seen.has(id)).sort())

  return {
    shell,
    rosters: {
      pages,
      components: [...rosterIds(rosters, 'components')].sort(),
      layouts: [...rosterIds(rosters, 'layouts')].sort(),
    },
  }
}
