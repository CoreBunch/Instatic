/**
 * extractFragment — cut a section, a page, or a Visual Component out of a
 * source site together with its closure, as a portable `SiteFragment`.
 *
 * The closure, in the order it is collected:
 *
 *   1. Nodes — the selected subtrees, deep-copied (a component selection
 *      becomes one instance of the component, slot instances materialised).
 *   2. Visual Components — every `base.visual-component-ref` target,
 *      transitively; their trees feed every later step.
 *   3. Class rules — every class a carried node (or component) uses. Framework
 *      utilities are carried by NAME only (styles stripped; the target
 *      regenerates its own), scoped module-style rules and regular rules whole.
 *   4. Ambient rules — every ambient rule whose selector names a carried class,
 *      plus each `@keyframes` block a carried declaration animates with.
 *      Rules that style the selection through a class on one of its
 *      ANCESTORS are not carried; they are reported as outside dependencies.
 *   5. Conditions — every non-viewport context id a carried rule keys on.
 *   6. Tokens — every `var(--x)` the content reads, classified by the
 *      framework's own generators: colour (full token definition), type or
 *      space scale step (by name), font token (+ its library entry), or any
 *      other custom property (valued from the source root rules).
 *   7. Tables — loops over `data.rows` carry their table and rows; CMS forms
 *      carry their target table's schema.
 *   8. Media — every library asset a string in the closure references by
 *      path, every custom font file, every media cell of a carried row.
 *   9. Links — every `cms:page:<id>` target with the source page's slug.
 *
 * Pure apart from reading media bytes through the source (and hashing them);
 * returns a fragment that has passed `parseSiteFragment`.
 */

import { nanoid } from 'nanoid'
import { collectSubtreeIds, extractCssSelectorClasses, type Page, type PageNode, type StyleRule } from '@core/page-tree'
import {
  applySlotSyncResult,
  forEachVCRef,
  syncSlotInstances,
  type VisualComponent,
} from '@core/visualComponents'
import { collectPageRefIds, forEachString, nodeContent } from './references'
import {
  SITE_FRAGMENT_FORMAT,
  SITE_FRAGMENT_VERSION,
  parseSiteFragment,
  type FragmentKind,
  type FragmentLink,
  type FragmentTable,
  type SiteFragment,
} from './schema'
import type { FragmentSource } from './source'
import type { FragmentWarning } from './warnings'
import {
  FRAMEWORK_ID_PREFIX,
  carryKeyframes,
  collectConditions,
  findOutsideDependencies,
  frameworkStub,
} from './extractStyles'
import { collectTokens, type FrameworkStepUse } from './extractTokens'
import { collectMedia, collectTables, type MediaSrcOption } from './extractData'

/**
 * What to extract: part of a page (`rootNodeIds`, siblings in document
 * order), a whole page (no `rootNodeIds`), or a Visual Component.
 * In a bundle, a page id is its `pages` row id.
 */
export type FragmentSelection =
  | { pageId: string; rootNodeIds?: string[] }
  | { componentId: string }

export interface ExtractFragmentOptions {
  origin?: SiteFragment['origin']
  /**
   * How `media[].src` is written. Default: the package path
   * (`media/<key>.<ext>`) when the bytes were read, else the source path.
   */
  mediaSrc?: MediaSrcOption
}

export interface ExtractFragmentResult {
  fragment: SiteFragment
  /** Bytes read while extracting, by fragment media id — what a package zips. */
  mediaBytes: Map<string, Uint8Array>
  warnings: FragmentWarning[]
}

/** The selection does not resolve in the source. */
export class FragmentExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FragmentExtractError'
  }
}


export async function extractFragment(
  source: FragmentSource,
  selection: FragmentSelection,
  options: ExtractFragmentOptions = {},
): Promise<ExtractFragmentResult> {
  const warnings: FragmentWarning[] = []
  const { site } = source

  // ── 1. Nodes ───────────────────────────────────────────────────────────────
  const picked = pickSelection(source, selection)
  const { kind, roots, nodes } = picked

  // ── 2. Visual Component closure ────────────────────────────────────────────
  const components = collectComponents(site.visualComponents, nodes, warnings)
  const nodeSets: Record<string, PageNode>[] = [nodes, ...components.map((vc) => vc.tree.nodes as Record<string, PageNode>)]
  const allNodes = nodeSets.flatMap((set) => Object.values(set))

  // ── 3. Class rules ─────────────────────────────────────────────────────────
  const usedClassIds = new Set<string>()
  for (const node of allNodes) for (const id of node.classIds) usedClassIds.add(id)
  for (const vc of components) for (const id of vc.classIds) usedClassIds.add(id)

  const carried = new Map<string, StyleRule>()
  const frameworkColorIds = new Set<string>()
  const frameworkSteps: FrameworkStepUse[] = []
  for (const classId of usedClassIds) {
    const rule = site.styleRules[classId]
    if (!rule) continue
    if (classId.startsWith(FRAMEWORK_ID_PREFIX)) {
      carried.set(classId, frameworkStub(rule))
      const generated = rule.generated
      if (generated?.family === 'color') frameworkColorIds.add(generated.sourceId)
      else if (generated) {
        frameworkSteps.push({ family: generated.family, convention: generated.tokenName, step: generated.step })
      }
    } else {
      carried.set(classId, structuredClone(rule))
    }
  }
  const carriedClassNames = new Set([...carried.values()].map((rule) => rule.name))

  // ── 4. Ambient rules + outside dependencies ────────────────────────────────
  for (const rule of Object.values(site.styleRules)) {
    if (rule.kind !== 'ambient' || carried.has(rule.id)) continue
    const names = extractCssSelectorClasses(rule.selector).map((token) => token.name)
    if (names.some((name) => carriedClassNames.has(name))) carried.set(rule.id, structuredClone(rule))
  }
  carryKeyframes(site.styleRules, carried)
  const outsideDependencies = picked.page && kind === 'section'
    ? findOutsideDependencies(picked.page, roots, site.styleRules, carried, carriedClassNames)
    : []

  const styleRules = [...carried.values()].sort((a, b) => a.order - b.order)

  // ── 5. Conditions ──────────────────────────────────────────────────────────
  const conditions = collectConditions(styleRules, site.breakpoints.map((bp) => bp.id), site.conditions ?? [])

  // ── 7. Tables (before tokens/media: rows reference media and pages) ────────
  const tables = collectTables(source, allNodes, warnings)

  // ── 6. Tokens ──────────────────────────────────────────────────────────────
  const tokens = collectTokens(source, styleRules, allNodes, frameworkColorIds, frameworkSteps, warnings)

  // ── 8. Media ───────────────────────────────────────────────────────────────
  const { media, mediaBytes } = await collectMedia(
    source,
    { styleRules, allNodes, tables, fontFamilies: tokens.fontFamilies },
    options.mediaSrc,
    warnings,
  )

  // ── 9. Links ───────────────────────────────────────────────────────────────
  const links = collectLinks(site.pages, allNodes, tables, warnings)

  const fragment: SiteFragment = {
    format: SITE_FRAGMENT_FORMAT,
    version: SITE_FRAGMENT_VERSION,
    kind,
    ...(options.origin ? { origin: options.origin } : {}),
    roots,
    nodes,
    ...(picked.page && kind === 'page' ? { page: { title: picked.page.title, slug: picked.page.slug } } : {}),
    ...(picked.component ? { component: picked.component } : {}),
    styleRules,
    conditions,
    components,
    tokens,
    tables,
    media,
    links,
    ...(outsideDependencies.length > 0 ? { outsideDependencies } : {}),
  }

  return { fragment: parseSiteFragment(fragment), mediaBytes, warnings }
}

// ---------------------------------------------------------------------------
// 1. Selection
// ---------------------------------------------------------------------------

interface PickedSelection {
  kind: FragmentKind
  roots: string[]
  nodes: Record<string, PageNode>
  page?: Page
  component?: { id: string; name: string }
}

function pickSelection(source: FragmentSource, selection: FragmentSelection): PickedSelection {
  if ('componentId' in selection) {
    const vc = source.site.visualComponents.find((c) => c.id === selection.componentId)
    if (!vc) throw new FragmentExtractError(`Visual Component "${selection.componentId}" not found`)
    // One instance of the component, slot instances materialised exactly the
    // way inserting it from the module inserter would.
    const ref: PageNode = {
      id: nanoid(),
      moduleId: 'base.visual-component-ref',
      props: { componentId: vc.id, propOverrides: {} },
      breakpointOverrides: {},
      children: [],
      classIds: [],
      parentId: null,
    }
    const nodes: Record<string, PageNode> = { [ref.id]: ref }
    applySlotSyncResult(nodes, syncSlotInstances(ref, vc, nodes), ref.id)
    return { kind: 'component', roots: [ref.id], nodes, component: { id: vc.id, name: vc.name } }
  }

  const page = source.site.pages.find((p) => p.id === selection.pageId)
  if (!page) throw new FragmentExtractError(`Page "${selection.pageId}" not found`)

  const requested = selection.rootNodeIds ?? []
  if (requested.length === 0) {
    return { kind: 'page', roots: [page.rootNodeId], nodes: copySubtrees(page, [page.rootNodeId]), page }
  }

  for (const id of requested) {
    if (!page.nodes[id]) throw new FragmentExtractError(`Node "${id}" not found on page "${page.id}"`)
    if (id === page.rootNodeId) throw new FragmentExtractError('Select sections inside the page, or no nodes for the whole page')
  }
  // A root inside another selected root is already carried by it.
  const unique = [...new Set(requested)]
  const roots = unique.filter((id) => {
    const inside = new Set<string>()
    for (const other of unique) {
      if (other === id) continue
      for (const descendant of collectSubtreeIds(page.nodes, other)) inside.add(descendant)
    }
    return !inside.has(id)
  })
  return { kind: 'section', roots, nodes: copySubtrees(page, roots), page }
}

function copySubtrees(page: Page, roots: string[]): Record<string, PageNode> {
  const nodes: Record<string, PageNode> = {}
  for (const rootId of roots) {
    for (const id of collectSubtreeIds(page.nodes, rootId)) {
      const node = page.nodes[id]
      if (node) nodes[id] = structuredClone(node)
    }
  }
  for (const rootId of roots) {
    const root = nodes[rootId]
    if (root) root.parentId = null
  }
  return nodes
}

// ---------------------------------------------------------------------------
// 2. Visual Components
// ---------------------------------------------------------------------------

function collectComponents(
  all: readonly VisualComponent[],
  nodes: Record<string, PageNode>,
  warnings: FragmentWarning[],
): VisualComponent[] {
  const byId = new Map(all.map((vc) => [vc.id, vc]))
  const out: VisualComponent[] = []
  const seen = new Set<string>()
  const queue: string[] = []
  const enqueue = (nodeMap: unknown) =>
    forEachVCRef(nodeMap, ({ componentId }) => {
      if (!seen.has(componentId)) {
        seen.add(componentId)
        queue.push(componentId)
      }
    })
  enqueue(nodes)
  while (queue.length > 0) {
    const id = queue.shift()!
    const vc = byId.get(id)
    if (!vc) {
      warnings.push({
        code: 'missing-component',
        message: `A component instance references component "${id}", which the source site does not have.`,
        subject: id,
      })
      continue
    }
    const copy = structuredClone(vc)
    out.push(copy)
    enqueue(copy.tree.nodes)
  }
  return out
}

// ---------------------------------------------------------------------------
// 9. Links
// ---------------------------------------------------------------------------

function collectLinks(
  pages: readonly Page[],
  allNodes: PageNode[],
  tables: FragmentTable[],
  warnings: FragmentWarning[],
): FragmentLink[] {
  const ids = new Set<string>()
  const scan = (text: string) => collectPageRefIds(text, ids)
  for (const node of allNodes) for (const part of nodeContent(node)) forEachString(part, scan)
  for (const table of tables) for (const row of table.rows ?? []) forEachString(row.cells, scan)

  const links: FragmentLink[] = []
  for (const pageId of ids) {
    const page = pages.find((p) => p.id === pageId)
    if (!page) {
      warnings.push({
        code: 'missing-page-link',
        message: `A link points at page "${pageId}", which the source site does not have; it inserts as "#".`,
        subject: pageId,
      })
      continue
    }
    links.push({ pageId, slug: page.slug })
  }
  return links
}
