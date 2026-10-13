/**
 * planFragmentInsert — decide everything an insert will add to a site, and
 * report it, without changing anything. Pure: no I/O, no store access.
 *
 * The site always wins (decided by the product owner):
 *
 *   - Node ids: all new.
 *   - Classes match by NAME. The site's class is reused as is, even when its
 *     styles differ; a class the site lacks is added with a fresh id at the
 *     end of the cascade, in the fragment's relative order. Scoped
 *     module-style rules are cloned onto the new node ids. Framework
 *     utilities match by name against the site's framework AFTER the token
 *     merge (so a colour the insert adds brings its utilities), and are
 *     dropped when the site does not generate them.
 *   - Ambient rules match by exact selector; the site's rule wins.
 *   - Conditions match by id.
 *   - Tokens: see `planTokens.ts`. Tables: see `planData.ts`.
 *   - Visual Components match by name (the storage slug); the site's component
 *     wins and instances point at it. A missing one is added with fresh ids.
 *   - Links: `cms:page:<id>` to a page whose slug the site has is remapped to
 *     that page; any other becomes `#` and is reported.
 *   - A fragment never adds a page unless it IS a page.
 *   - The one-outlet-per-document invariant and the component cycle guard
 *     hold exactly as they do for saved layouts.
 */

import { nanoid } from 'nanoid'
import {
  cloneNodeWithRemap,
  collectSubtreeIds,
  createStyleRuleOrderAllocator,
  extractCssSelectorClasses,
  reindexNodeParents,
  removeNodeSubtrees,
  uniquePageSlug,
  type NodeTree,
  type PageNode,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'
import { generateFrameworkUtilityClasses } from '@core/framework'
import { firstOutletId, treeHasOutlet } from '@core/templates'
import { forEachVCRef, vcSlugFromName, wouldCreateCycle, type VisualComponent } from '@core/visualComponents'
import { mapNodeStrings, mapStrings, remapTableRefs, rewritePageRefs } from './references'
import { planCustomProperties, planTokens, type TokenPlan } from './planTokens'
import { planTables, referencedMedia } from './planData'
import type { SiteFragment } from './schema'
import type {
  FragmentInsertPlan,
  FragmentInsertReport,
  FragmentInsertTarget,
} from './planTypes'
import type { FragmentWarning } from './warnings'

export type FragmentInsertErrorCode =
  | 'no-document'
  | 'document-not-found'
  | 'outlet-conflict'
  | 'component-cycle'

/** The insert cannot happen here. `code` lets the UI say why. */
export class FragmentInsertError extends Error {
  readonly code: FragmentInsertErrorCode
  constructor(code: FragmentInsertErrorCode, message: string) {
    super(message)
    this.name = 'FragmentInsertError'
    this.code = code
  }
}

const FRAMEWORK_ID_PREFIX = 'framework:'
const VC_REF = 'base.visual-component-ref'

export function planFragmentInsert(target: FragmentInsertTarget, fragment: SiteFragment): FragmentInsertPlan {
  const { site } = target
  const warnings: FragmentWarning[] = []
  const report = emptyReport(fragment)
  const hostTree = resolveHostTree(target, fragment)

  // ── Tokens first: framework utilities resolve against the merged settings ──
  const tokens = planTokens(site, fragment, report, warnings)
  const allocateOrder = createStyleRuleOrderAllocator(site.styleRules)
  const customProperties = planCustomProperties(site, fragment, tokens, allocateOrder, report, warnings)

  // ── Visual Components: reuse by name, mint ids for the rest ───────────────
  const { vcIdMap, addedVcs } = planComponents(site, fragment, report)

  // ── Node ids for everything that lands: placed nodes + added trees ─────────
  const nodeIdMap = new Map<string, string>()
  for (const rootId of fragment.roots) {
    for (const id of collectSubtreeIds(fragment.nodes, rootId)) nodeIdMap.set(id, nanoid())
  }
  const vcNodeIdMaps = new Map<string, Map<string, string>>()
  for (const vc of addedVcs) {
    const map = new Map<string, string>()
    for (const id of Object.keys(vc.tree.nodes)) map.set(id, nanoid())
    vcNodeIdMaps.set(vc.id, map)
  }
  const scopeNodeId = (id: string) =>
    nodeIdMap.get(id) ?? [...vcNodeIdMaps.values()].find((map) => map.has(id))?.get(id)

  // ── Rules: only what the landing nodes and added components use ───────────
  const usedClassIds = new Set<string>()
  for (const id of nodeIdMap.keys()) for (const classId of fragment.nodes[id]?.classIds ?? []) usedClassIds.add(classId)
  for (const vc of addedVcs) {
    for (const classId of vc.classIds) usedClassIds.add(classId)
    for (const node of Object.values(vc.tree.nodes)) for (const classId of node.classIds) usedClassIds.add(classId)
  }
  const { styleRules, classIdMap } = planRules(site, fragment, usedClassIds, tokens, allocateOrder, scopeNodeId, report, warnings)
  const classIdRemap = (id: string) => classIdMap.get(id) ?? null

  // ── Conditions ─────────────────────────────────────────────────────────────
  const conditionIds = new Set((site.conditions ?? []).map((c) => c.id))
  const conditions = fragment.conditions.filter((c) => !conditionIds.has(c.id)).map((c) => structuredClone(c))
  for (const c of conditions) report.conditions.added.push(c.label || c.id)
  warnMissingContexts(site, [...conditionIds, ...conditions.map((c) => c.id)], styleRules, fragment, warnings)

  // ── Tables ─────────────────────────────────────────────────────────────────
  const { tables, tableIdMap } = planTables(target, fragment, report, warnings)

  // ── Page (kind 'page' only) ────────────────────────────────────────────────
  const page = fragment.kind === 'page' && fragment.page
    ? { id: nanoid(), title: fragment.page.title, slug: uniquePageSlug(fragment.page.slug, site.pages) }
    : undefined
  if (page) report.page = { title: page.title, slug: page.slug }

  // ── Content rewrites shared by placed nodes and added component trees ──────
  const resolveLink = linkResolver(site, fragment, page?.id, report)
  const rewrite = (node: PageNode): PageNode => {
    let next = mapNodeStrings(node, (text) => rewritePageRefs(text, resolveLink))
    next = remapTableRefs(next, tableIdMap)
    if (next.moduleId === VC_REF && typeof next.props.componentId === 'string') {
      const mapped = vcIdMap.get(next.props.componentId)
      if (mapped && mapped !== next.props.componentId) next = { ...next, props: { ...next.props, componentId: mapped } }
    }
    return next
  }

  // Rows of created tables can hold links too (rich text).
  for (const table of tables) {
    if (table.action !== 'create') continue
    table.rows = table.rows.map((row) => ({ ...row, cells: mapStrings(row.cells, (text) => rewritePageRefs(text, resolveLink)) }))
  }

  // Placed nodes.
  const nodes: Record<string, PageNode> = {}
  for (const [oldId, newId] of nodeIdMap) {
    const node = fragment.nodes[oldId]
    if (!node) continue
    nodes[newId] = rewrite(cloneNodeWithRemap(node, { newId, idMap: nodeIdMap, classIdRemap }))
  }
  const roots = fragment.roots.map((id) => nodeIdMap.get(id)!).filter(Boolean)
  reindexNodeParents(nodes)
  dropDanglingRefs(nodes, vcIdMap, site, warnings)
  const placedRoots = roots.filter((id) => nodes[id])

  // Added component trees.
  const components: VisualComponent[] = addedVcs.map((vc) => {
    const idMap = vcNodeIdMaps.get(vc.id)!
    const treeNodes: Record<string, PageNode> = {}
    for (const [oldId, newId] of idMap) {
      treeNodes[newId] = rewrite(cloneNodeWithRemap(vc.tree.nodes[oldId] as PageNode, { newId, idMap, classIdRemap }))
    }
    reindexNodeParents(treeNodes)
    dropDanglingRefs(treeNodes, vcIdMap, site, warnings)
    return {
      ...structuredClone(vc),
      id: vcIdMap.get(vc.id)!,
      tree: { nodes: treeNodes, rootNodeId: idMap.get(vc.tree.rootNodeId)! },
      classIds: vc.classIds.flatMap((id) => {
        const mapped = classIdRemap(id)
        return mapped ? [mapped] : []
      }),
      createdAt: Date.now(),
    }
  })

  // ── Guards (same rules as inserting a saved layout) ────────────────────────
  if (hostTree && firstOutletId(nodes) !== null && treeHasOutlet(hostTree)) {
    throw new FragmentInsertError('outlet-conflict', 'This fragment includes a content outlet and this document already has one.')
  }
  if (target.document?.kind === 'visualComponent') {
    const roster = [...site.visualComponents, ...components]
    for (const node of Object.values(nodes)) {
      if (node.moduleId !== VC_REF || typeof node.props.componentId !== 'string') continue
      if (wouldCreateCycle(roster, target.document.vcId, node.props.componentId)) {
        throw new FragmentInsertError('component-cycle', 'This fragment contains a component that references the component being edited.')
      }
    }
  }

  report.nodes = Object.keys(nodes).length
  const media = referencedMedia(fragment, {
    nodes: Object.values(nodes),
    components,
    rules: [...styleRules],
    fontFamilies: tokens.fontFamilies,
    tables,
  })
  report.media.total = media.length
  report.warnings = warnings

  return {
    kind: fragment.kind,
    ...(target.document && fragment.kind !== 'page' ? { document: target.document } : {}),
    ...(page ? { page } : {}),
    roots: placedRoots,
    nodes,
    styleRules,
    customProperties,
    conditions,
    colorTokens: tokens.colorTokens,
    scaleSteps: tokens.scaleSteps,
    fontFamilies: tokens.fontFamilies,
    fontTokens: tokens.fontTokens,
    components,
    tables,
    media,
    report,
  }
}

/**
 * Walk component references from the placed nodes. A component the site
 * already has (same name) is reused and NOT descended into: its nested
 * components are the site's business. Only components reached through added
 * ones are added, so reusing `Card` never drags in the fragment's `Badge`.
 */
function planComponents(
  site: SiteDocument,
  fragment: SiteFragment,
  report: FragmentInsertReport,
): { vcIdMap: Map<string, string>; addedVcs: VisualComponent[] } {
  const siteVcBySlug = new Map(site.visualComponents.map((vc) => [vcSlugFromName(vc.name), vc]))
  const fragmentVcs = new Map(fragment.components.map((vc) => [vc.id, vc]))
  const vcIdMap = new Map<string, string>()
  const addedVcs: VisualComponent[] = []
  const queue: string[] = []
  const placed: Record<string, PageNode> = {}
  for (const rootId of fragment.roots) {
    for (const id of collectSubtreeIds(fragment.nodes, rootId)) placed[id] = fragment.nodes[id]
  }
  forEachVCRef(placed, ({ componentId }) => queue.push(componentId))
  while (queue.length > 0) {
    const id = queue.shift()!
    if (vcIdMap.has(id)) continue
    const vc = fragmentVcs.get(id)
    if (!vc) continue
    const match = siteVcBySlug.get(vcSlugFromName(vc.name))
    if (match) {
      vcIdMap.set(vc.id, match.id)
      report.components.reused.push(match.name)
      continue
    }
    vcIdMap.set(vc.id, nanoid())
    addedVcs.push(vc)
    report.components.added.push(vc.name)
    forEachVCRef(vc.tree.nodes, ({ componentId }) => queue.push(componentId))
  }
  return { vcIdMap, addedVcs }
}

function emptyReport(fragment: SiteFragment): FragmentInsertReport {
  return {
    kind: fragment.kind,
    nodes: 0,
    colors: { added: [], kept: [] },
    fonts: { tokensAdded: [], tokensKept: [], familiesAdded: [], familiesKept: [] },
    steps: { added: [] },
    customProperties: { added: [], kept: [] },
    rules: { added: [], reused: [], ambientAdded: [], ambientKept: [] },
    conditions: { added: [] },
    components: { added: [], reused: [] },
    tables: { created: [], reused: [], fieldsAdded: [], rows: 0 },
    media: { total: 0, uploaded: 0, reused: 0 },
    links: { remapped: [], unresolved: [] },
    outsideDependencies: fragment.outsideDependencies ?? [],
    warnings: [],
  }
}

function resolveHostTree(target: FragmentInsertTarget, fragment: SiteFragment): NodeTree<PageNode> | null {
  if (fragment.kind === 'page') return null
  const document = target.document
  if (!document) {
    throw new FragmentInsertError('no-document', 'Open a page or component to insert this fragment into.')
  }
  if (document.kind === 'page') {
    const page = target.site.pages.find((p) => p.id === document.pageId)
    if (!page) throw new FragmentInsertError('document-not-found', `Page "${document.pageId}" not found`)
    return page
  }
  const vc = target.site.visualComponents.find((v) => v.id === document.vcId)
  if (!vc) throw new FragmentInsertError('document-not-found', `Component "${document.vcId}" not found`)
  return vc.tree as NodeTree<PageNode>
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function planRules(
  site: SiteDocument,
  fragment: SiteFragment,
  usedClassIds: Set<string>,
  tokens: TokenPlan,
  allocateOrder: () => number,
  scopeNodeId: (id: string) => string | undefined,
  report: FragmentInsertReport,
  warnings: FragmentWarning[],
): { styleRules: StyleRule[]; classIdMap: Map<string, string> } {
  const frameworkByName = new Map<string, string>()
  for (const cls of Object.values(generateFrameworkUtilityClasses(tokens.nextFramework))) {
    frameworkByName.set(cls.name, cls.id)
  }
  const classByName = new Map<string, string>()
  const ambientSelectors = new Set<string>()
  for (const rule of Object.values(site.styleRules)) {
    if (rule.kind === 'ambient') ambientSelectors.add(rule.selector)
    else if (!rule.scope && !rule.id.startsWith(FRAMEWORK_ID_PREFIX) && !classByName.has(rule.name)) {
      classByName.set(rule.name, rule.id)
    }
  }

  const now = Date.now()
  const classIdMap = new Map<string, string>()
  const styleRules: StyleRule[] = []
  const add = (rule: StyleRule, id: string, extra: Partial<StyleRule> = {}) => {
    const { origin: _origin, generated: _generated, ...rest } = structuredClone(rule)
    styleRules.push({ ...rest, ...extra, id, order: allocateOrder(), createdAt: now, updatedAt: now })
  }

  // Ambient rules ride along only when they name a class that lands (or name
  // no class at all, like an animation's @keyframes): a rule built on the
  // fragment's copy of a component the site already has is not needed.
  const usedNames = new Set(
    fragment.styleRules.filter((rule) => usedClassIds.has(rule.id)).map((rule) => rule.name),
  )
  const ambientNeeded = (rule: StyleRule) => {
    const names = extractCssSelectorClasses(rule.selector).map((token) => token.name)
    return names.length === 0 || names.some((name) => usedNames.has(name))
  }

  for (const rule of [...fragment.styleRules].sort((a, b) => a.order - b.order)) {
    if (rule.kind === 'ambient' ? !ambientNeeded(rule) : !usedClassIds.has(rule.id)) continue
    if (rule.id.startsWith(FRAMEWORK_ID_PREFIX)) {
      const id = frameworkByName.get(rule.name)
      if (id) classIdMap.set(rule.id, id)
      else {
        warnings.push({
          code: 'framework-class-dropped',
          message: `The site's framework does not generate "${rule.name}", so it is left off.`,
          subject: rule.name,
        })
      }
      continue
    }
    if (rule.scope?.type === 'node') {
      const nodeId = scopeNodeId(rule.scope.nodeId)
      if (!nodeId) continue
      const id = nanoid()
      classIdMap.set(rule.id, id)
      add(rule, id, { scope: { ...rule.scope, nodeId } })
      continue
    }
    if (rule.kind === 'class') {
      const existing = frameworkByName.get(rule.name) ?? classByName.get(rule.name)
      if (existing) {
        classIdMap.set(rule.id, existing)
        report.rules.reused.push(rule.name)
        continue
      }
      const id = nanoid()
      classIdMap.set(rule.id, id)
      classByName.set(rule.name, id)
      add(rule, id)
      report.rules.added.push(rule.name)
      continue
    }
    if (ambientSelectors.has(rule.selector)) {
      report.rules.ambientKept.push(rule.selector)
      continue
    }
    ambientSelectors.add(rule.selector)
    add(rule, nanoid())
    report.rules.ambientAdded.push(rule.selector)
  }
  return { styleRules, classIdMap }
}

function warnMissingContexts(
  site: SiteDocument,
  conditionIds: string[],
  rules: StyleRule[],
  fragment: SiteFragment,
  warnings: FragmentWarning[],
): void {
  const known = new Set([...site.breakpoints.map((bp) => bp.id), ...conditionIds])
  const missing = new Set<string>()
  for (const rule of rules) {
    for (const key of Object.keys(rule.contextStyles)) if (!known.has(key)) missing.add(key)
  }
  for (const node of Object.values(fragment.nodes)) {
    for (const key of Object.keys(node.breakpointOverrides)) if (!known.has(key)) missing.add(key)
  }
  for (const key of missing) {
    warnings.push({
      code: 'missing-context',
      message: `Styles for "${key}" have no matching breakpoint or condition in this site, so they do not apply.`,
      subject: key,
    })
  }
}

// ---------------------------------------------------------------------------
// Content rewrites
// ---------------------------------------------------------------------------

function linkResolver(
  site: SiteDocument,
  fragment: SiteFragment,
  newPageId: string | undefined,
  report: FragmentInsertReport,
): (pageId: string) => string | null {
  const slugBySourceId = new Map(fragment.links.map((l) => [l.pageId, l.slug]))
  const seen = new Set<string>()
  return (pageId) => {
    const slug = slugBySourceId.get(pageId)
    // A page fragment's links to itself follow it to its new page.
    let resolved: string | null = null
    if (slug !== undefined && newPageId && slug === fragment.page?.slug) resolved = newPageId
    else if (slug !== undefined) resolved = site.pages.find((p) => p.slug === slug)?.id ?? null
    if (!seen.has(pageId)) {
      seen.add(pageId)
      const label = slug || pageId
      if (resolved) report.links.remapped.push(label)
      else report.links.unresolved.push(label)
    }
    return resolved
  }
}

/**
 * Strip instances of components that neither travel in the fragment nor
 * exist in the site (whole instance subtree), like a saved layout heals refs
 * to deleted components.
 */
function dropDanglingRefs(
  nodes: Record<string, PageNode>,
  vcIdMap: Map<string, string>,
  site: SiteDocument,
  warnings: FragmentWarning[],
): void {
  const known = new Set([...vcIdMap.values(), ...site.visualComponents.map((vc) => vc.id)])
  const dangling: string[] = []
  for (const node of Object.values(nodes)) {
    if (node.moduleId !== VC_REF) continue
    const id = node.props.componentId
    if (typeof id === 'string' && id && !known.has(id)) {
      dangling.push(node.id)
      warnings.push({
        code: 'component-ref-dropped',
        message: `An instance of component "${id}" was left out: the fragment does not carry that component.`,
        subject: id,
      })
    }
  }
  if (dangling.length > 0) removeNodeSubtrees(nodes, dangling)
}
