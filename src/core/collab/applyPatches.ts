/**
 * Mutative-patch → Y translation — the collaborative WRITE path.
 *
 * The editor's mutation engine keeps producing site-relative Mutative
 * patches (unchanged recipes, unchanged mutation API); this module turns one
 * mutation's patch set into Y operations on the right documents, inside one
 * transaction per touched doc, tagged with the caller's origin.
 *
 * Translation philosophy: patches identify TARGETS; values are written from
 * the post-mutation site (`nextSite`) — final-state writes are idempotent
 * under duplicate patches and immune to op-ordering subtleties. Exceptions
 * where granularity matters:
 *   - inline-text props go through `applyTextDiff` (minimal Y.Text splices,
 *     so concurrent remote edits survive),
 *   - children arrays go through a prefix/suffix array diff (targeted
 *     inserts/deletes, so concurrent child insertions survive),
 *   - roster membership is derived from a pre/post id-set diff (the same
 *     robust-to-recipe-style approach as save-dirty tracking).
 *
 * Anything unattributable falls back to repopulating the affected doc from
 * `nextSite` — the conservative escape hatch, mirroring dirty-tracking's
 * `all` rule (over-writing is safe; silently dropping an edit is not).
 */
import * as Y from 'yjs'
import type { Patches } from 'mutative'
import type { BaseNode, Page, SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import { dataMap, inlineTextPropOf, metaMap, rostersMap, shellMap, treeMap } from './schema'
import { buildBreakpointOverridesMap, buildNodeMap, buildPropsMap } from './nodeY'
import { populateComponentDoc, populateLayoutDoc, populatePageDoc } from './seed'
import { applyTextDiff } from './textDiff'
import type { CollabDocSet } from './docSet'

type Collection = 'pages' | 'visualComponents' | 'layouts'
const COLLECTIONS: readonly Collection[] = ['pages', 'visualComponents', 'layouts']
const COLLECTION_KIND: Record<Collection, 'page' | 'component' | 'layout'> = {
  pages: 'page',
  visualComponents: 'component',
  layouts: 'layout',
}
const SHELL_PER_ENTRY_KEYS = new Set(['settings', 'styleRules', 'explorer'])
const SHELL_SKIPPED_KEYS = new Set(['updatedAt', 'id'])

type Row = Page | VisualComponent | SavedLayout

function rowsOf(site: SiteDocument, col: Collection): readonly Row[] {
  return site[col]
}

function rowsById(site: SiteDocument, col: Collection): Map<string, Row> {
  return new Map(rowsOf(site, col).map((row) => [row.id, row]))
}

/** Mutative types `path` as `(string | number)[] | string`; the store always
 * produces arrays (default `pathAsArray`) — normalize once for type safety. */
function patchPath(patch: Patches[number]): readonly (string | number)[] {
  return typeof patch.path === 'string' ? patch.path.split('/').filter(Boolean) : patch.path
}

/** Same predicate as dirty tracking: only ops at collection depth ≤ 2, a
 * `length` bookkeeping op, or any remove can change membership/order. */
function isMembershipShapedOp(patch: Patches[number]): boolean {
  return patchPath(patch).length <= 2
}

function clearMap(map: Y.Map<unknown>): void {
  for (const key of [...map.keys()]) map.delete(key)
}

function clearRowDoc(doc: Y.Doc): void {
  clearMap(metaMap(doc))
  clearMap(treeMap(doc))
  clearMap(dataMap(doc))
}

function repopulateRowDoc(doc: Y.Doc, kind: 'page' | 'component' | 'layout', row: Row): void {
  clearRowDoc(doc)
  if (kind === 'page') populatePageDoc(doc, row as Page)
  else if (kind === 'component') populateComponentDoc(doc, row as VisualComponent)
  else populateLayoutDoc(doc, row as SavedLayout)
}

/** Prefix/suffix splice of a Y.Array<string> toward `next` — preserves
 * concurrent remote insertions outside the changed window. */
function applyChildrenDiff(arr: Y.Array<string>, pre: readonly string[], next: readonly string[]): void {
  let prefix = 0
  const maxPrefix = Math.min(pre.length, next.length)
  while (prefix < maxPrefix && pre[prefix] === next[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(pre.length, next.length) - prefix
  while (suffix < maxSuffix && pre[pre.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const deleteCount = pre.length - prefix - suffix
  if (deleteCount > 0) arr.delete(prefix, deleteCount)
  const inserted = next.slice(prefix, next.length - suffix)
  if (inserted.length > 0) arr.insert(prefix, [...inserted])
}

// ---------------------------------------------------------------------------
// Per-row target application (pages + components share the tree writer)
// ---------------------------------------------------------------------------

interface TreeShapes {
  nodes: Record<string, BaseNode>
  rootNodeId: string
}

function treeOf(kind: 'page' | 'component', row: Row): TreeShapes {
  return kind === 'page'
    ? (row as Page)
    : (row as VisualComponent).tree
}

/**
 * Apply one row's collected sub-paths (relative to the row) by writing the
 * affected targets from the FINAL row state. `preRow` feeds the text/children
 * diffs. Runs inside the row doc's transaction.
 */
function applyRowTargets(
  doc: Y.Doc,
  kind: 'page' | 'component',
  subPaths: readonly (readonly (string | number)[])[],
  preRow: Row | undefined,
  nextRow: Row,
): void {
  const tree = treeMap(doc)
  const meta = metaMap(doc)
  const nextTree = treeOf(kind, nextRow)
  const preTree = preRow ? treeOf(kind, preRow) : undefined
  const yNodes = tree.get('nodes') as Y.Map<unknown> | undefined
  if (!yNodes) {
    repopulateRowDoc(doc, kind, nextRow)
    return
  }

  // Collected targets — dedupe so the final state is written exactly once.
  const wholeNodes = new Set<string>() // set/delete whole node
  const childrenDiff = new Set<string>()
  const propKeys = new Map<string, Set<string>>() // nodeId → prop keys
  const bpTargets = new Map<string, Set<string>>() // nodeId → bp ids ('' = whole map)
  const scalarFields = new Map<string, Set<string>>() // nodeId → field names
  const metaKeys = new Set<string>()
  let rebuildAllNodes = false
  let rootNodeIdChanged = false

  for (const sub of subPaths) {
    // Normalize component paths: the row nests its tree under `tree`.
    let path = sub
    if (kind === 'component' && path[0] === 'tree') path = path.slice(1)
    else if (kind === 'component' && path.length > 0 && path[0] !== 'tree') {
      metaKeys.add(String(path[0]))
      continue
    }

    const head = path[0]
    if (head === undefined) {
      rebuildAllNodes = true
      metaKeys.add('*')
      continue
    }
    if (head === 'rootNodeId') {
      rootNodeIdChanged = true
      continue
    }
    if (head !== 'nodes') {
      if (kind === 'page') metaKeys.add(String(head))
      continue
    }
    const nodeId = path[1]
    if (nodeId === undefined) {
      rebuildAllNodes = true
      continue
    }
    if (typeof nodeId !== 'string') {
      rebuildAllNodes = true
      continue
    }
    const field = path[2]
    if (field === undefined) {
      wholeNodes.add(nodeId)
      continue
    }
    if (field === 'parentId') continue // derived — never stored
    if (field === 'children') {
      childrenDiff.add(nodeId)
    } else if (field === 'props') {
      const key = path[3]
      if (key === undefined) {
        scalarFields.get(nodeId) // no-op read for lint symmetry
        propKeys.set(nodeId, propKeys.get(nodeId) ?? new Set())
        propKeys.get(nodeId)!.add('*')
      } else {
        propKeys.set(nodeId, propKeys.get(nodeId) ?? new Set())
        propKeys.get(nodeId)!.add(String(key))
      }
    } else if (field === 'breakpointOverrides') {
      const bp = path[3]
      bpTargets.set(nodeId, bpTargets.get(nodeId) ?? new Set())
      bpTargets.get(nodeId)!.add(bp === undefined ? '*' : String(bp))
    } else {
      scalarFields.set(nodeId, scalarFields.get(nodeId) ?? new Set())
      scalarFields.get(nodeId)!.add(String(field))
    }
  }

  if (rebuildAllNodes) {
    repopulateRowDoc(doc, kind, nextRow)
    return
  }

  // Meta (page: row-level extra keys; component: non-tree keys).
  if (metaKeys.has('*')) {
    clearMap(meta)
    const metaSource: Record<string, unknown> = { ...nextRow }
    delete metaSource.id
    if (kind === 'page') {
      delete metaSource.nodes
      delete metaSource.rootNodeId
    } else {
      delete (metaSource as { tree?: unknown }).tree
    }
    for (const [key, value] of Object.entries(metaSource)) {
      if (value !== undefined) meta.set(key, value)
    }
  } else {
    for (const key of metaKeys) {
      const value = (nextRow as unknown as Record<string, unknown>)[key]
      if (value === undefined) meta.delete(key)
      else meta.set(key, value)
    }
  }

  if (rootNodeIdChanged) tree.set('rootNodeId', nextTree.rootNodeId)

  for (const nodeId of wholeNodes) {
    const nextNode = nextTree.nodes[nodeId]
    if (!nextNode) {
      yNodes.delete(nodeId)
      continue
    }
    const preNode = preTree?.nodes[nodeId]
    if (preNode && yNodes.has(nodeId)) {
      // Whole-node replace of an EXISTING node (paste-over, template ops):
      // repopulate that node only.
      yNodes.set(nodeId, buildNodeMap(nextNode))
    } else {
      yNodes.set(nodeId, buildNodeMap(nextNode))
    }
  }

  const nodeYMap = (nodeId: string): Y.Map<unknown> | undefined => {
    const value = yNodes.get(nodeId)
    return value instanceof Y.Map ? value : undefined
  }

  for (const nodeId of childrenDiff) {
    if (wholeNodes.has(nodeId)) continue // already rebuilt wholesale
    const yNode = nodeYMap(nodeId)
    const nextNode = nextTree.nodes[nodeId]
    if (!yNode || !nextNode) continue
    const arr = yNode.get('children') as Y.Array<string>
    const pre = preTree?.nodes[nodeId]?.children ?? arr.toArray()
    applyChildrenDiff(arr, pre, nextNode.children)
  }

  for (const [nodeId, keys] of propKeys) {
    if (wholeNodes.has(nodeId)) continue
    const yNode = nodeYMap(nodeId)
    const nextNode = nextTree.nodes[nodeId]
    if (!yNode || !nextNode) continue
    if (keys.has('*')) {
      yNode.set('props', buildPropsMap(nextNode.moduleId, nextNode.props))
      continue
    }
    const props = yNode.get('props') as Y.Map<unknown>
    const inlineProp = inlineTextPropOf(nextNode.moduleId)
    for (const key of keys) {
      const nextValue = nextNode.props[key]
      if (nextValue === undefined) {
        props.delete(key)
        continue
      }
      if (key === inlineProp && typeof nextValue === 'string') {
        const existing = props.get(key)
        if (existing instanceof Y.Text) {
          const preValue = preTree?.nodes[nodeId]?.props[key]
          applyTextDiff(existing, typeof preValue === 'string' ? preValue : existing.toString(), nextValue)
        } else {
          props.set(key, new Y.Text(nextValue))
        }
      } else {
        props.set(key, nextValue)
      }
    }
  }

  for (const [nodeId, bps] of bpTargets) {
    if (wholeNodes.has(nodeId)) continue
    const yNode = nodeYMap(nodeId)
    const nextNode = nextTree.nodes[nodeId]
    if (!yNode || !nextNode) continue
    if (bps.has('*')) {
      yNode.set('breakpointOverrides', buildBreakpointOverridesMap(nextNode.breakpointOverrides))
      continue
    }
    const overrides = yNode.get('breakpointOverrides') as Y.Map<unknown>
    for (const bp of bps) {
      const nextBag = nextNode.breakpointOverrides[bp]
      if (nextBag === undefined) {
        overrides.delete(bp)
        continue
      }
      const bpMap = new Y.Map<unknown>()
      for (const [key, value] of Object.entries(nextBag)) bpMap.set(key, value)
      overrides.set(bp, bpMap)
    }
  }

  for (const [nodeId, fields] of scalarFields) {
    if (wholeNodes.has(nodeId)) continue
    const yNode = nodeYMap(nodeId)
    const nextNode = nextTree.nodes[nodeId] as unknown as Record<string, unknown> | undefined
    if (!yNode || !nextNode) continue
    for (const field of fields) {
      const value = nextNode[field]
      if (value === undefined) yNode.delete(field)
      else yNode.set(field, value)
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function applySitePatchesToDocs(
  patches: Patches,
  preSite: SiteDocument,
  nextSite: SiteDocument,
  docs: CollabDocSet,
  origin: unknown,
): void {
  const shellHeads = new Set<string>()
  const shellEntryTargets = new Map<string, Set<string>>() // head → entry keys ('*' = whole)
  const collectionPatches = new Map<Collection, Patches[number][]>()

  for (const patch of patches) {
    const path = patchPath(patch)
    const head = String(path[0])
    if (COLLECTIONS.includes(head as Collection)) {
      const col = head as Collection
      collectionPatches.set(col, collectionPatches.get(col) ?? [])
      collectionPatches.get(col)!.push(patch)
      continue
    }
    if (SHELL_SKIPPED_KEYS.has(head)) continue
    if (SHELL_PER_ENTRY_KEYS.has(head)) {
      shellEntryTargets.set(head, shellEntryTargets.get(head) ?? new Set())
      shellEntryTargets.get(head)!.add(path.length === 1 ? '*' : String(path[1]))
    } else {
      shellHeads.add(head)
    }
  }

  // ── Shell + rosters (the site doc) ────────────────────────────────────────
  const rosterWork: Array<() => void> = []
  const collectionsWithMembershipOps: Collection[] = []
  for (const [col, colPatches] of collectionPatches) {
    if (colPatches.some(isMembershipShapedOp)) collectionsWithMembershipOps.push(col)
  }

  if (shellHeads.size > 0 || shellEntryTargets.size > 0 || collectionsWithMembershipOps.length > 0) {
    const siteDoc = docs.ensure('site:default')
    siteDoc.transact(() => {
      const shell = shellMap(siteDoc)
      for (const head of shellHeads) {
        const value = (nextSite as unknown as Record<string, unknown>)[head]
        if (value === undefined) shell.delete(head)
        else shell.set(head, value)
      }
      for (const [head, targets] of shellEntryTargets) {
        const nextEntries = (nextSite as unknown as Record<string, Record<string, unknown>>)[head] ?? {}
        let entryMap = shell.get(head)
        if (!(entryMap instanceof Y.Map)) {
          entryMap = new Y.Map<unknown>()
          shell.set(head, entryMap)
        }
        const map = entryMap as Y.Map<unknown>
        if (targets.has('*')) {
          clearMap(map)
          for (const [key, value] of Object.entries(nextEntries)) {
            if (value !== undefined) map.set(key, value)
          }
          continue
        }
        for (const key of targets) {
          const value = nextEntries[key]
          if (value === undefined) map.delete(key)
          else map.set(key, value)
        }
      }

      const rosters = rostersMap(siteDoc)
      for (const col of collectionsWithMembershipOps) {
        const rosterKey = col === 'pages' ? 'pages' : col === 'visualComponents' ? 'components' : 'layouts'
        let membership = rosters.get(rosterKey)
        if (!(membership instanceof Y.Map)) {
          membership = new Y.Map<unknown>()
          rosters.set(rosterKey, membership)
        }
        const memberMap = membership as Y.Map<unknown>
        const preIds = new Set(rowsOf(preSite, col).map((r) => r.id))
        const nextById = rowsById(nextSite, col)
        for (const id of nextById.keys()) {
          if (!preIds.has(id)) {
            memberMap.set(id, true)
            // Client-created row: populate a fresh doc (single author — safe).
            const kind = COLLECTION_KIND[col]
            rosterWork.push(() => {
              const rowDoc = docs.ensure(`${kind}:${id}`)
              rowDoc.transact(() => repopulateRowDoc(rowDoc, kind, nextById.get(id)!), origin)
            })
          }
        }
        for (const id of preIds) {
          if (!nextById.has(id)) memberMap.delete(id)
        }
        if (col === 'pages') {
          let order = rosters.get('pageOrder')
          if (!(order instanceof Y.Array)) {
            order = new Y.Array<string>()
            rosters.set('pageOrder', order)
          }
          applyChildrenDiff(
            order as Y.Array<string>,
            preSite.pages.map((p) => p.id),
            nextSite.pages.map((p) => p.id),
          )
        }
      }
    }, origin)
  }
  for (const work of rosterWork) work()

  // ── Per-row content ───────────────────────────────────────────────────────
  for (const [col, colPatches] of collectionPatches) {
    const kind = COLLECTION_KIND[col]
    const preById = rowsById(preSite, col)
    const nextById = rowsById(nextSite, col)

    // Wholesale collection replacement (imports) → repopulate every row doc.
    if (colPatches.some((p) => patchPath(p).length === 1)) {
      for (const [id, row] of nextById) {
        const rowDoc = docs.ensure(`${kind}:${id}`)
        rowDoc.transact(() => repopulateRowDoc(rowDoc, kind, row), origin)
      }
      continue
    }

    // Whole-row replaces at depth 2: repopulate rows whose object identity
    // changed (a reorder moves the SAME objects — skipped by the ref check).
    const rowSubPaths = new Map<string, (readonly (string | number)[])[]>()
    for (const patch of colPatches) {
      const path = patchPath(patch)
      const index = path[1]
      if (typeof index !== 'number') continue
      const rest = path.slice(2)
      const row = patch.op === 'remove' && rest.length === 0
        ? undefined // row removal — handled by the roster diff above
        : nextSite[col][index]
      if (!row) continue
      const id = (row as Row).id
      if (rest.length === 0) {
        if (preById.get(id) !== nextById.get(id)) {
          const rowDoc = docs.ensure(`${kind}:${id}`)
          rowDoc.transact(() => repopulateRowDoc(rowDoc, kind, row as Row), origin)
        }
        continue
      }
      if (!preById.has(id)) continue // freshly created — already populated
      rowSubPaths.set(id, rowSubPaths.get(id) ?? [])
      rowSubPaths.get(id)!.push(rest)
    }

    for (const [id, subPaths] of rowSubPaths) {
      const nextRow = nextById.get(id)
      if (!nextRow) continue
      const rowDoc = docs.ensure(`${kind}:${id}`)
      if (kind === 'layout') {
        // Whole-snapshot LWW — any layout content change rewrites the snapshot.
        rowDoc.transact(() => repopulateRowDoc(rowDoc, 'layout', nextRow), origin)
        continue
      }
      rowDoc.transact(
        () => applyRowTargets(rowDoc, kind, subPaths, preById.get(id), nextRow),
        origin,
      )
    }
  }
}
