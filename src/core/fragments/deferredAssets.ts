import type { FontEntry } from '@core/fonts'
import type { PageNode, SiteDocument } from '@core/page-tree'
import { installFonts, resolveMedia, writeTables, writeTableRows, type CommitFragmentPlanOptions, type ResolvedMedia } from './commit'
import type { FragmentInsertAdapter } from './adapter'
import type { FragmentMedia } from './schema'
import type { FragmentInsertPlan } from './planTypes'
import { createPathReplacer, mapNodeStrings, mapRuleStrings, mapStrings } from './references'
import { resolveFragmentPlan } from './resolve'
import type { FragmentWarning } from './warnings'

function placeholder(item: FragmentMedia, layoutOnly: boolean) {
  const width = Math.max(1, Math.round(item.width ?? 1))
  const height = Math.max(1, Math.round(item.height ?? 1))
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"/>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg).replaceAll("'", '%27') + (layoutOnly ? '' : '#' + crypto.randomUUID())
}

/** The temporary image is self-contained. Its fragment identifies the exact pending reference. */
export async function placeFragmentLayout(plan: FragmentInsertPlan, adapter: FragmentInsertAdapter, options: CommitFragmentPlanOptions, layoutOnly: boolean) {
  const placeholders = new Map(plan.media.map(item => [item.path, placeholder(item, layoutOnly)]))
  const media = { urlByPath: placeholders, idById: new Map<string, string>(), uploaded: 0, reused: 0 }
  // A wireframe can use existing collections. Leave missing collection selectors empty.
  const tableIdMap = layoutOnly
    ? new Map(plan.tables.map(table => [table.fragmentTableId, table.action === 'reuse' ? table.tableId : '']))
    : await writeTables(plan, media, adapter, options, false)
  options.signal?.throwIfAborted()
  const initial = resolveFragmentPlan(plan, { mediaUrlByPath: placeholders, tableIdMap, fontEntryByFamilyId: new Map() })
  options.onProgress?.({ phase: 'commit', done: 0, total: 1 })
  const result = await adapter.commit(initial)
  return { result, placeholders, tableIdMap }
}

export async function loadFragmentAssets(plan: FragmentInsertPlan, tables: Map<string, string>, adapter: FragmentInsertAdapter, options: CommitFragmentPlanOptions) {
  const warnings: FragmentWarning[] = []
  const media = await resolveMedia(plan.media, adapter, options, (item, error) => {
    warnings.push({ code: 'missing-media-bytes', message: error.message, subject: item.filename })
  })
  const fonts = await installFonts(plan.fontFamilies, media.idById, adapter, options, warnings)
  return { media, fonts, warnings, seedRows: () => writeTableRows(plan, tables, media, adapter, options) }
}

/** Replace only markers that are still present in the inserted nodes and styles. */
export interface ImportedFragmentAssets {
  placeholders: Map<string, string>
  media: ResolvedMedia
  fonts: Map<string, FontEntry>
}

export function finishFragmentAssets(site: SiteDocument, plan: FragmentInsertPlan, { placeholders, media, fonts }: ImportedFragmentAssets): boolean {
  const doc = plan.document
  const pageId = plan.page?.id ?? (doc?.kind === 'page' ? doc.pageId : undefined)
  const tree = pageId ? site.pages.find(p => p.id === pageId) : doc?.kind === 'visualComponent' ? site.visualComponents.find(vc => vc.id === doc.vcId)?.tree : null
  if (!tree || !plan.roots.some(id => tree.nodes[id])) return false
  const paths = new Map<string,string>()
  for (const [path, marker] of placeholders) {
    const url = media.urlByPath.get(path)
    if (url) paths.set(marker, url)
  }
  const replace = createPathReplacer(paths)
  let changed = false
  function updateNodes(nodes: Record<string, PageNode>, ids: string[]) {
    for (const id of ids) {
      const node = nodes[id]
      if (!node) continue
      const next = mapNodeStrings(node, replace)
      if (next !== node) {
        Object.assign(node, { props: next.props, breakpointOverrides: next.breakpointOverrides })
        if (next.inlineStyles) node.inlineStyles = next.inlineStyles
        changed = true
      }
    }
  }
  updateNodes(tree.nodes, Object.keys(plan.nodes))
  for (const component of plan.components) {
    const vc = site.visualComponents.find(v => v.id === component.id)
    if (!vc) continue
    updateNodes(vc.tree.nodes, Object.keys(component.tree.nodes))
    const params = mapStrings(vc.params, replace)
    if (params !== vc.params) { vc.params = params; changed = true }
  }
  const ruleIds = plan.styleRules.map(rule => rule.id)
  if (plan.customProperties) ruleIds.push(plan.customProperties.ruleId)
  for (const id of ruleIds) {
    const rule = site.styleRules[id]
    if (!rule) continue
    const next = mapRuleStrings(rule, replace)
    if (next !== rule) {
      rule.styles = next.styles
      rule.contextStyles = next.contextStyles
      if (next.rawCss !== undefined) rule.rawCss = next.rawCss
      changed = true
    }
  }
  for (const entry of fonts.values()) {
    const settings = site.settings.fonts ??= { items: [] }
    if (!settings.items.some(item => item.id === entry.id)) { settings.items.push(entry); changed = true }
  }
  for (const token of plan.fontTokens) {
    const entry = token.familyId && fonts.get(token.familyId)
    const dest = site.settings.fonts?.tokens?.find(t => t.id === token.id)
    if (entry && dest && !dest.familyId && dest.updatedAt === token.updatedAt) { dest.familyId = entry.id; changed = true }
  }
  return changed
}
