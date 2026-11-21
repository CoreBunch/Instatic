/**
 * applyResolvedFragment — write a resolved plan into a site document.
 *
 * Mechanical: every decision was made by the planner. Mutates `site` (and the
 * placement tree) in place, so the editor runs it inside ONE Mutative recipe
 * and the whole insert is one undo step; tests run it on plain objects.
 *
 * Framework utility classes are NOT regenerated here — that reconcile lives
 * with the editor store. When `frameworkChanged` is true the caller must
 * regenerate them in the same transaction (the planner already resolved the
 * fragment's utility class ids against the regenerated set).
 */

import {
  addMissingConditions,
  addPage,
  collectSubtreeIds,
  reconcileSiteExplorerInPlace,
  reindexNodeParents,
  type NodeTree,
  type PageNode,
  type SiteDocument,
  type StyleRule,
} from '@core/page-tree'
import { normalizeFrameworkColorSlug } from '@core/framework'
import { normalizeFontTokenVariable } from '@core/fonts'
import { applySlotSyncResult, syncSlotInstances } from '@core/visualComponents'
import { FRAGMENT_PROPERTIES_ORIGIN } from './planTokens'
import type { PlannedCustomProperties } from './planTypes'
import type { FragmentApplyResult, ResolvedFragmentPlan } from './resolve'

/** Where a section or component lands: under `parentId`, at `index` (append when omitted). */
export interface FragmentPlacement {
  tree: NodeTree<PageNode>
  parentId: string
  index?: number
}

export function applyResolvedFragment(
  site: SiteDocument,
  plan: ResolvedFragmentPlan,
  placement: FragmentPlacement | null,
): FragmentApplyResult & { frameworkChanged: boolean } {
  const now = Date.now()

  // ── Conditions, tokens, fonts ──────────────────────────────────────────────
  addMissingConditions(site, plan.conditions)

  if (plan.colorTokens.length > 0) {
    site.settings.framework ??= { colors: { tokens: [] } }
    const tokens = site.settings.framework.colors.tokens
    const slugs = new Set(tokens.map((t) => normalizeFrameworkColorSlug(t.slug)))
    for (const token of plan.colorTokens) if (!slugs.has(token.slug)) tokens.push(token)
  }
  const { typography, spacing, preferences } = plan.scaleGroups
  if (typography.length || spacing.length) {
    const framework = site.settings.framework ??= { colors: { tokens: [] } }
    framework.preferences ??= preferences
    if (typography.length) addMissingScaleGroups(framework.typography ??= { groups: [] }, typography)
    if (spacing.length) addMissingScaleGroups(framework.spacing ??= { groups: [] }, spacing)
  }
  for (const update of plan.scaleSteps) {
    const groups = update.family === 'typography'
      ? site.settings.framework?.typography?.groups
      : site.settings.framework?.spacing?.groups
    const group = groups?.find((g) => g.id === update.groupId)
    if (!group) continue
    group.steps = update.steps
    group.baseScaleIndex = update.baseScaleIndex
    group.updatedAt = now
  }

  if (plan.fontEntries.length > 0 || plan.fontTokens.length > 0) {
    site.settings.fonts ??= { items: [] }
    const fonts = site.settings.fonts
    for (const entry of plan.fontEntries) {
      if (!fonts.items.some((f) => f.id === entry.id)) fonts.items.push(entry)
    }
    if (plan.fontTokens.length > 0) {
      fonts.tokens ??= []
      const variables = new Set(fonts.tokens.map((t) => normalizeFontTokenVariable(t.variable)))
      for (const token of plan.fontTokens) if (!variables.has(token.variable)) fonts.tokens.push(token)
    }
  }

  // ── Rules ──────────────────────────────────────────────────────────────────
  if (plan.customProperties) writeRootProperties(site, plan.customProperties, 'add-missing', now)
  for (const rule of plan.styleRules) site.styleRules[rule.id] = rule

  // ── Components ─────────────────────────────────────────────────────────────
  for (const vc of plan.components) {
    if (!site.visualComponents.some((existing) => existing.id === vc.id)) site.visualComponents.push(vc)
  }
  for (const vc of plan.components) {
    const added = site.visualComponents.find((existing) => existing.id === vc.id)
    if (added) {
      const nodes = added.tree.nodes as Record<string, PageNode>
      syncSlotInstancesIn(site, nodes, Object.keys(nodes))
    }
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────
  let result: FragmentApplyResult
  if (plan.page) {
    const page = addPage(site, plan.page.title, plan.page.slug)
    page.id = plan.page.id
    if (plan.page.access) page.access = structuredClone(plan.page.access)
    if (plan.page.seo) page.seo = structuredClone(plan.page.seo)
    page.nodes = { ...plan.nodes }
    page.rootNodeId = plan.roots[0]
    syncSlotInstancesIn(site, page.nodes, Object.keys(page.nodes))
    reindexNodeParents(page.nodes)
    result = { rootIds: [page.rootNodeId], pageId: page.id }
  } else {
    if (!placement) throw new Error('[fragments] a section or component needs a placement')
    const { tree, parentId } = placement
    const parent = tree.nodes[parentId]
    if (!parent) throw new Error(`[fragments] placement parent "${parentId}" not found`)
    for (const [id, node] of Object.entries(plan.nodes)) tree.nodes[id] = node
    const index = placement.index === undefined ? parent.children.length : Math.max(0, Math.min(placement.index, parent.children.length))
    parent.children.splice(index, 0, ...plan.roots)
    syncSlotInstancesIn(site, tree.nodes, plan.roots.flatMap((rootId) => collectSubtreeIds(tree.nodes, rootId)))
    reindexNodeParents(tree.nodes)
    result = { rootIds: [...plan.roots] }
  }

  if (plan.components.length > 0 || plan.page) reconcileSiteExplorerInPlace(site)
  const frameworkChanged = [plan.colorTokens, typography, spacing, plan.scaleSteps].some(items => items.length > 0)
  return { ...result, frameworkChanged }
}

function addMissingScaleGroups<Group extends { namingConvention: string }>(
  settings: { groups: Group[]; isDisabled?: boolean },
  additions: Group[],
): void {
  if (settings.isDisabled) return
  const conventions = new Set(settings.groups.map(group => group.namingConvention))
  for (const group of additions) if (!conventions.has(group.namingConvention)) settings.groups.push(group)
}

/**
 * Materialise slot instances for every component instance among `ids`
 * against the component that now lives in the site (the site's own when it
 * was reused by name), exactly as inserting the component by hand does.
 */
function syncSlotInstancesIn(site: SiteDocument, nodes: Record<string, PageNode>, ids: Iterable<string>): void {
  for (const id of [...ids]) {
    const node = nodes[id]
    if (node?.moduleId !== 'base.visual-component-ref') continue
    const vc = site.visualComponents.find((v) => v.id === node.props.componentId)
    if (vc) applySlotSyncResult(nodes, syncSlotInstances(node, vc, nodes), id)
  }
}

/**
 * Write root custom properties into the rule `planned.ruleId` names. An
 * existing rule (the engine-owned one, or for a theme a user's root rule that
 * already declares the property) gets the values: only the missing ones for
 * a fragment insert (`add-missing`), every one for a theme (`overwrite`). A
 * rule that does not exist yet is created as the engine-owned `:root` rule
 * (`origin.source === FRAGMENT_PROPERTIES_ORIGIN`).
 */
export function writeRootProperties(
  site: SiteDocument,
  planned: PlannedCustomProperties,
  mode: 'add-missing' | 'overwrite',
  now: number,
): void {
  const existing = site.styleRules[planned.ruleId]
  if (existing) {
    for (const [name, value] of Object.entries(planned.properties)) {
      if (mode === 'overwrite' || !(name in existing.styles)) existing.styles[name] = value
    }
    existing.updatedAt = now
    return
  }
  const rule: StyleRule = {
    id: planned.ruleId,
    name: ':root',
    kind: 'ambient',
    selector: ':root',
    order: planned.order,
    description: 'Custom properties added by inserted fragments and applied themes',
    styles: { ...planned.properties },
    contextStyles: {},
    origin: { source: FRAGMENT_PROPERTIES_ORIGIN, ordinal: 0 },
    createdAt: now,
    updatedAt: now,
  }
  site.styleRules[rule.id] = rule
}
