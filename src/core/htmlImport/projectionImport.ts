/**
 * Uid-preserving projection import (God Mode ticket 03) — the inverse of the
 * publisher's editable HTML projection (`RenderConfig.projection`,
 * `renderProjection.ts`).
 *
 * `importProjectionHtml(source, { tree, rootId, styleRules })` parses edited
 * projection HTML back into a replacement subtree for `rootId`:
 *
 *   - An element whose `uid` matches a node in the projected subtree PATCHES
 *     that node in place: same id, and its label, locked/hidden flags,
 *     breakpoint overrides, and prop/dynamic bindings all survive. The
 *     element's position decides the node's position (moves and reorders are
 *     moves, never delete+recreate). A matched element that maps to a
 *     DIFFERENT module (the author re-tagged it, e.g. `<p>` → `<div>`) keeps
 *     the node's identity and metadata but takes the new module's props.
 *   - Projected attributes are a PARTIAL view of a matched node's props:
 *     only what the dialect projects is patched; unprojected keys survive.
 *     The loop `filters` bag is the canonical case (`patchLoopProps`).
 *   - An element without a `uid` (or with an unknown/duplicate one) creates
 *     a new node via the shared rule table — exactly the lossy path's mapping.
 *   - A uid present in the base subtree but absent from the edited HTML is a
 *     deletion, reported in the diff (with locked / Component-structure
 *     deletions singled out so callers can gate destructive applies).
 *
 * Bare text nodes (`base.text` with `tag: 'none'`) render without an element
 * and therefore cannot carry a uid. They are re-adopted positionally: a
 * synthesized text child under a matched parent takes over the parent's next
 * unclaimed bare-text child from the base tree, keeping its id and metadata.
 *
 * The function is PURE — it never mutates `options.tree`. Callers (the HTML
 * panel's apply) inspect the diff first, then splice `result.nodes` in place
 * of the old subtree and reindex parents.
 */

import { registry } from '@core/module-engine'
import { collectSubtreeIds, type NodeTree, type PageNode, type StyleRule } from '@core/page-tree'
import { deepEqual } from '@core/utils/deepEqual'
import { parseHtml } from './parseHtml'
import { stripUnsafe, collectStyleCss } from './stripUnsafe'
import type { StripReport } from './stripUnsafe'
import { harvestInlineStyles } from './inlineStyle'
import { walkAndMap, HTML_ATTRIBUTE_MODULES } from './walkAndMap'
import type { MappedElement } from './walkAndMap'
import type { ImportWarning } from './importWarnings'
import { patchLoopProps } from './instaticDialect'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProjectionImportOptions {
  /** The base tree the projection was rendered from. Never mutated. */
  tree: NodeTree<PageNode>
  /** Root of the projected subtree — `result.rootId` is always this id. */
  rootId: string
  /**
   * The site's style-rule registry, used to link the `class` attribute's
   * names back to registry class ids. A name that matches no rule stays a
   * name on `classIds`, for the caller to link on insert (same convention as
   * the lossy path's `insertImportedNodes`).
   */
  styleRules: Record<string, StyleRule>
}

/**
 * What the import would change, computed against the base subtree BEFORE
 * anything mutates — the destructive-diff confirm (God Mode ticket 07) gates
 * on the deleted-locked / deleted-structural lists.
 */
export interface ProjectionImportDiff {
  /** Nodes minted for elements without a (usable) uid. */
  createdIds: string[]
  /** Matched nodes whose content, module, position, or children changed. */
  patchedIds: string[]
  /** Base-subtree nodes absent from the edited HTML (root never deletes). */
  deletedIds: string[]
  /** The subset of `deletedIds` that were locked nodes. */
  deletedLockedIds: string[]
  /** The subset of `deletedIds` that were VC refs / slot instances / slot outlets. */
  deletedStructuralIds: string[]
  /**
   * Matched ids whose module changed AWAY from a VC ref / slot instance /
   * slot outlet (the author re-tagged the marker element). The node survives
   * (subset of `patchedIds`) but the Component/slot structure is dismantled —
   * exactly as destructive as deleting it, so confirm gates must treat it
   * like `deletedStructuralIds`.
   */
  retypedStructuralIds: string[]
}

export interface ProjectionImportResult {
  /** The full replacement subtree (root included), keyed by node id. */
  nodes: Record<string, PageNode>
  /** Always `options.rootId` — the splice point in the caller's tree. */
  rootId: string
  diff: ProjectionImportDiff
  warnings: ImportWarning[]
  stripped: StripReport
  /** Raw `<style>` CSS from the source, if any (mirrors `importHtml`). */
  styleCss: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// DOM nodeType constant, numeric so this browser-bundled module needs no
// `Node` global (mirrors walkAndMap.ts).
const TEXT_NODE = 3

/** Module ids whose deletion dismantles Component/slot structure. */
const STRUCTURAL_MODULE_IDS = new Set([
  'base.visual-component-ref',
  'base.slot-instance',
  'base.slot-outlet',
])


/**
 * Read every element's `uid` attribute into a map and REMOVE the attribute,
 * so identity never leaks into `props.htmlAttributes` through the walker's
 * attribute collection.
 */
function collectAndStripUids(doc: Document): Map<Element, string> {
  const uids = new Map<Element, string>()
  for (const el of Array.from(doc.querySelectorAll('[uid]'))) {
    const uid = el.getAttribute('uid')
    if (uid) uids.set(el, uid)
    el.removeAttribute('uid')
  }
  return uids
}

/** True when `doc.body`'s direct text children are all insignificant whitespace. */
function bodyHasNoSignificantText(body: HTMLElement): boolean {
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === TEXT_NODE && !/^\s*$/.test(child.textContent ?? '')) {
      return false
    }
  }
  return true
}

function isNonEmptyRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  )
}

/**
 * The uid-carried metadata a matched node keeps through a patch (and through
 * a re-tag): everything the projection deliberately never emits.
 */
function carriedMetadata(existing: PageNode): Partial<PageNode> {
  return {
    ...(typeof existing.label === 'string' ? { label: existing.label } : {}),
    ...(typeof existing.locked === 'boolean' ? { locked: existing.locked } : {}),
    ...(typeof existing.hidden === 'boolean' ? { hidden: existing.hidden } : {}),
    ...(existing.propBindings !== undefined ? { propBindings: existing.propBindings } : {}),
    ...(existing.dynamicBindings !== undefined
      ? { dynamicBindings: existing.dynamicBindings }
      : {}),
  }
}

/**
 * Patch a matched node's props from its edited element. The mapped props are
 * the dialect's PARTIAL view: they overwrite what they project and leave
 * every other stored key untouched. Loops route through `patchLoopProps`
 * (attribute-presence semantics + the `filters` partial view); for
 * htmlAttribute-collecting modules, an element with no collectable
 * attributes left clears a previously non-empty `htmlAttributes` bag.
 */
function patchMatchedProps(
  el: Element,
  existing: PageNode,
  mapped: MappedElement,
): Record<string, unknown> {
  const props =
    mapped.moduleId === 'base.loop'
      ? patchLoopProps(el, existing.props)
      : { ...existing.props, ...mapped.props }

  if (mapped.moduleId === 'base.loop' && mapped.props.htmlAttributes !== undefined) {
    props.htmlAttributes = mapped.props.htmlAttributes
  }
  if (
    HTML_ATTRIBUTE_MODULES.has(mapped.moduleId) &&
    mapped.props.htmlAttributes === undefined &&
    isNonEmptyRecord(existing.props.htmlAttributes)
  ) {
    props.htmlAttributes = {}
  }
  return props
}

/**
 * Strip `parentId` and undefined-valued keys so patch detection compares
 * substance, not index bookkeeping (`parentId` is a derived cache recomputed
 * on insert) or key-presence noise.
 */
function comparableNode(node: PageNode): Record<string, unknown> {
  const { parentId: _parentId, ...rest } = node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** True for a walker-synthesized bare text node (`base.text`, `tag: 'none'`). */
function isBareTextNode(node: PageNode | undefined): boolean {
  return node !== undefined && node.moduleId === 'base.text' && node.props.tag === 'none'
}

/**
 * Re-adopt bare text identity: for each matched parent, walk its new
 * children in order and let every synthesized bare-text child take over the
 * parent's next unclaimed bare-text child from the base tree — same id, old
 * metadata/props preserved, new text patched in. Mutates `nodes` (the
 * importer's own output map).
 */
function adoptBareTextNodes(
  nodes: Record<string, PageNode>,
  tree: NodeTree<PageNode>,
): void {
  for (const parent of Object.values(nodes)) {
    const baseParent = tree.nodes[parent.id]
    if (!baseParent) continue

    const pool = baseParent.children.filter((childId) => {
      return isBareTextNode(tree.nodes[childId]) && nodes[childId] === undefined
    })
    if (pool.length === 0) continue

    parent.children = parent.children.map((childId) => {
      // Only walker-synthesized text nodes are adoptable — they always carry
      // a fresh id, so anything already present in the base tree is skipped.
      const child = nodes[childId]
      if (tree.nodes[childId] !== undefined || !isBareTextNode(child)) return childId
      const adoptedId = pool.shift()
      if (adoptedId === undefined) return childId

      const base = tree.nodes[adoptedId]!
      nodes[adoptedId] = structuredClone({
        ...base,
        props: { ...base.props, text: child!.props.text },
        children: [],
        parentId: null,
      })
      delete nodes[childId]
      return adoptedId
    })
  }
}

/**
 * Link the class NAMES the walker copied from each element's `class`
 * attribute back to registry class ids. Unknown names stay names (the caller
 * links or creates them on insert); tokens that are already ids (the
 * preserved root, adopted bare-text nodes) match no rule name and pass
 * through unchanged.
 */
function resolveClassNames(
  nodes: Record<string, PageNode>,
  styleRules: Record<string, StyleRule>,
): void {
  const idByName = new Map<string, string>()
  for (const rule of Object.values(styleRules)) {
    if (!idByName.has(rule.name)) idByName.set(rule.name, rule.id)
  }
  for (const node of Object.values(nodes)) {
    node.classIds = node.classIds.map((token) => idByName.get(token) ?? token)
  }
}

function computeDiff(
  tree: NodeTree<PageNode>,
  rootId: string,
  nodes: Record<string, PageNode>,
): ProjectionImportDiff {
  const baseIds = new Set(collectSubtreeIds(tree.nodes, rootId))

  const createdIds: string[] = []
  const patchedIds: string[] = []
  const retypedStructuralIds: string[] = []
  for (const [id, node] of Object.entries(nodes)) {
    if (!baseIds.has(id)) {
      createdIds.push(id)
      continue
    }
    const base = tree.nodes[id]!
    if (!deepEqual(comparableNode(base), comparableNode(node))) {
      patchedIds.push(id)
    }
    if (STRUCTURAL_MODULE_IDS.has(base.moduleId) && node.moduleId !== base.moduleId) {
      retypedStructuralIds.push(id)
    }
  }

  const deletedIds = [...baseIds].filter((id) => nodes[id] === undefined)
  return {
    createdIds,
    patchedIds,
    deletedIds,
    deletedLockedIds: deletedIds.filter((id) => tree.nodes[id]!.locked === true),
    deletedStructuralIds: deletedIds.filter((id) =>
      STRUCTURAL_MODULE_IDS.has(tree.nodes[id]!.moduleId),
    ),
    retypedStructuralIds,
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse edited projection HTML into a replacement subtree for
 * `options.rootId`, preserving node identity via `uid` attributes. Pure —
 * see the module doc for the full contract.
 *
 * Root handling: when the source is exactly one top-level element carrying
 * `uid="<rootId>"` (the projection of a non-body subtree), that element
 * re-describes the root node itself. Otherwise — a page projection (base.body
 * emits no wrapper), or a root whose uid the author removed — the base root
 * node is preserved as-is and the top-level items become its children.
 */
export function importProjectionHtml(
  source: string,
  options: ProjectionImportOptions,
): ProjectionImportResult {
  const { tree, rootId, styleRules } = options
  const baseRoot = tree.nodes[rootId]
  if (!baseRoot) {
    throw new Error(`[htmlImport] importProjectionHtml: unknown root node "${rootId}"`)
  }

  const doc = parseHtml(source)
  const uids = collectAndStripUids(doc)
  const inlineStyles = harvestInlineStyles(doc)
  const styleCss = collectStyleCss(doc)
  const stripped = stripUnsafe(doc)

  // Matching candidates: the projected subtree only. A uid pointing anywhere
  // else in the tree cannot be spliced by a subtree replace, so it mints a
  // new node instead of stealing one.
  const subtreeIds = new Set(collectSubtreeIds(tree.nodes, rootId))

  // Root-descriptor mode: the source is the projection of the root element
  // itself. Anything else (page projection, wrapped/removed root) preserves
  // the base root and treats top-level items as its children — in that mode
  // the root uid is not matchable, so a nested duplicate becomes a new node.
  const bodyElements = doc.body ? Array.from(doc.body.children) : []
  const rootDescriptor =
    doc.body !== null &&
    bodyElements.length === 1 &&
    uids.get(bodyElements[0]!) === rootId &&
    bodyHasNoSignificantText(doc.body)

  const consumed = new Set<string>()
  const buildNode = (el: Element, mapped: MappedElement): PageNode | undefined => {
    const uid = uids.get(el)
    if (uid === undefined) return undefined
    if (!subtreeIds.has(uid) || consumed.has(uid)) return undefined
    if (uid === rootId && !rootDescriptor) return undefined
    consumed.add(uid)

    const existing = tree.nodes[uid]!
    const retagged = mapped.moduleId !== existing.moduleId
    const props = retagged
      ? { ...registry.getOrThrow(mapped.moduleId).defaults, ...mapped.props }
      : patchMatchedProps(el, existing, mapped)

    return structuredClone({
      id: existing.id,
      moduleId: mapped.moduleId,
      props,
      breakpointOverrides: existing.breakpointOverrides ?? {},
      children: [],
      classIds: [],
      parentId: null,
      ...carriedMetadata(existing),
    })
  }

  const walk = walkAndMap(doc, inlineStyles, { buildNode })

  const nodes: Record<string, PageNode> = { ...walk.nodes }
  if (!(rootDescriptor && nodes[rootId] !== undefined)) {
    nodes[rootId] = structuredClone({
      ...baseRoot,
      children: walk.rootIds,
      parentId: null,
    })
  }

  adoptBareTextNodes(nodes, tree)
  resolveClassNames(nodes, styleRules)
  const diff = computeDiff(tree, rootId, nodes)

  return { nodes, rootId, diff, warnings: walk.warnings, stripped, styleCss }
}
