/**
 * resolveFragmentPlan — swap the fragment's placeholders for the real ids the
 * server work produced: media paths for uploaded URLs, created-table ids for
 * the fragment's table ids, installed font family ids for the fragment's.
 * Pure; the result is what the single store transaction applies.
 */

import type { FontEntry } from '@core/fonts'
import type { PageNode } from '@core/page-tree'
import { createPathReplacer, mapNodeStrings, mapRuleStrings, remapTableRefs } from './references'
import type { FragmentInsertPlan } from './planTypes'

/** The plan with every reference resolved; what the store transaction applies. */
export type ResolvedFragmentPlan = Omit<FragmentInsertPlan, 'fontFamilies' | 'tables' | 'media'> & {
  /** Font library entries installed or registered for this insert. */
  fontEntries: FontEntry[]
}

/** What applying a resolved plan placed. */
export interface FragmentApplyResult {
  /** New root node ids, in order (a page fragment: the new page's body). */
  rootIds: string[]
  /** The page a page fragment added. */
  pageId?: string
}

export interface FragmentResolution {
  /** Fragment media path → uploaded (or reused) URL. */
  mediaUrlByPath: ReadonlyMap<string, string>
  /** Fragment table id → site table id, for created tables. */
  tableIdMap: ReadonlyMap<string, string>
  /** Fragment font family id → installed entry. Failed installs are absent. */
  fontEntryByFamilyId: ReadonlyMap<string, FontEntry>
}

export function resolveFragmentPlan(plan: FragmentInsertPlan, resolution: FragmentResolution): ResolvedFragmentPlan {
  const replacePaths = createPathReplacer(resolution.mediaUrlByPath)
  const tableIdMap = new Map(resolution.tableIdMap)
  const resolveNode = <TNode extends PageNode>(node: TNode): TNode =>
    remapTableRefs(mapNodeStrings(node, replacePaths), tableIdMap) as TNode

  const nodes: Record<string, PageNode> = {}
  for (const [id, node] of Object.entries(plan.nodes)) nodes[id] = resolveNode(node)

  const components = plan.components.map((vc) => {
    const treeNodes: Record<string, PageNode> = {}
    for (const [id, node] of Object.entries(vc.tree.nodes)) treeNodes[id] = resolveNode(node as PageNode)
    return { ...vc, tree: { ...vc.tree, nodes: treeNodes } }
  })

  const fontTokens = plan.fontTokens.map((token) => {
    if (!token.familyId) return token
    const isFragmentFamily = plan.fontFamilies.some((f) => f.fragmentFamilyId === token.familyId)
    if (!isFragmentFamily) return token
    const installed = resolution.fontEntryByFamilyId.get(token.familyId)
    if (installed) return { ...token, familyId: installed.id }
    // The family did not install: the token falls back to its fallback stack.
    const { familyId: _unresolved, ...rest } = token
    return rest
  })

  const customProperties = plan.customProperties
    ? {
        ...plan.customProperties,
        properties: Object.fromEntries(
          Object.entries(plan.customProperties.properties).map(([name, value]) => [name, replacePaths(value)]),
        ),
      }
    : null

  const { fontFamilies: _fontFamilies, tables: _tables, media: _media, ...rest } = plan
  return {
    ...rest,
    nodes,
    components,
    styleRules: plan.styleRules.map((rule) => mapRuleStrings(rule, replacePaths)),
    customProperties,
    fontTokens,
    fontEntries: [...resolution.fontEntryByFamilyId.values()],
  }
}
