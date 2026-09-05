/**
 * cssPanelDocument — which CSS the God Mode CSS panel shows, derived from
 * editor state plus the rendered canvas:
 *
 *   - an element selected → its assigned class rules (assignment order),
 *     the ambient rules that match it (via the same selector model the
 *     Properties panel uses, so pills and panel never disagree), its inline
 *     styles as the `element` block, and the framework utilities it wears —
 *     collapsed and read-only, last;
 *   - nothing selected → every rule the page uses: classes assigned anywhere
 *     in the active tree plus ambient rules matching any rendered element.
 *
 * Usage annotations: class rules count assignments site-wide (editing a
 * shared class edits it everywhere — that number is the safety rail);
 * ambient rules count matches on the current page.
 */
import { isGeneratedClass, isUserVisibleClass, type StyleRule } from '@core/page-tree'
import {
  projectStylesheet,
  type StylesheetBlockInput,
  type StylesheetProjection,
} from '@core/cssProjection'
import type { BreakpointHint } from '@core/siteImport'
import { getActiveTree } from '@site/store/slices/selectionSlice'
import type { SelectionScopeInputs } from '../selectionScope'
import {
  authorCanvasRoot,
  countAmbientRuleMatches,
  deriveSelectorPickerModel,
} from '@site/panels/PropertiesPanel/selectorPickerModel'
import { buildSelectorUsageMap } from '@site/panels/selectorUsage'

/** The rendered-canvas lookup the derivation needs (injectable for tests). */
export interface CssPanelCanvas {
  findNodeElement(nodeId: string): Element | null
}

export interface CssPanelDocument {
  /** Identity of the projected document — changes when the scope changes. */
  docKey: string
  projection: StylesheetProjection
  /** Viewport contexts for folding `@media` back into breakpoint overrides. */
  breakpoints: BreakpointHint[]
}

function orderRules(
  rules: Record<string, StyleRule>,
  usage: Map<string, number>,
  countMatches: (rule: StyleRule) => number,
  classIds: readonly string[],
  ambient: readonly StyleRule[],
): StylesheetBlockInput[] {
  const classes: StylesheetBlockInput[] = []
  const framework: StylesheetBlockInput[] = []
  for (const classId of classIds) {
    const rule = rules[classId]
    if (!rule || rule.kind === 'ambient' || !isUserVisibleClass(rule)) continue
    const block: StylesheetBlockInput = { kind: 'rule', rule, usage: usage.get(classId) ?? 0 }
    if (isGeneratedClass(rule)) framework.push(block)
    else classes.push(block)
  }
  const ambientBlocks = ambient.map<StylesheetBlockInput>((rule) => ({
    kind: 'rule',
    rule,
    usage: countMatches(rule),
  }))
  return [...classes, ...ambientBlocks, ...framework]
}

function pageAmbientRules(rules: Record<string, StyleRule>, root: Element | null): StyleRule[] {
  if (!root) return []
  return Object.values(rules)
    .filter((rule) => rule.kind === 'ambient' && isUserVisibleClass(rule))
    .sort((a, b) => a.order - b.order)
    .filter((rule) => countAmbientRuleMatches(rule, root) > 0)
}

export function deriveCssPanelDocument(
  state: SelectionScopeInputs,
  canvas: CssPanelCanvas,
): CssPanelDocument | null {
  const { site } = state
  const tree = getActiveTree(state)
  if (!site || !tree) return null

  const rules = site.styleRules
  const usage = buildSelectorUsageMap(site)
  const breakpoints: BreakpointHint[] = site.breakpoints.map((bp) => ({
    id: bp.id,
    width: bp.width,
    mediaQuery: bp.mediaQuery,
  }))
  const rootElement = canvas.findNodeElement(tree.rootNodeId)
  const pageRoot = rootElement ? authorCanvasRoot(rootElement) : null
  const countMatches = (rule: StyleRule): number =>
    pageRoot ? countAmbientRuleMatches(rule, pageRoot) : 0
  const project = (blocks: StylesheetBlockInput[]) =>
    projectStylesheet({ blocks, breakpoints: site.breakpoints, conditions: site.conditions ?? [] })

  const selectedNode = state.selectedNodeId ? tree.nodes[state.selectedNodeId] : null
  if (selectedNode) {
    const model = deriveSelectorPickerModel({
      rules,
      node: selectedNode,
      selectedElement: canvas.findNodeElement(selectedNode.id),
      activeRuleId: null,
    })
    const ambient = model.pills.map((pill) => pill.rule).filter((rule) => rule.kind === 'ambient')
    const blocks = orderRules(rules, usage, countMatches, selectedNode.classIds ?? [], ambient)
    const inlineIndex = blocks.findIndex((block) => block.kind === 'rule' && isGeneratedClass(block.rule))
    const inline: StylesheetBlockInput = {
      kind: 'inline',
      nodeId: selectedNode.id,
      styles: selectedNode.inlineStyles ?? {},
    }
    blocks.splice(inlineIndex === -1 ? blocks.length : inlineIndex, 0, inline)
    return { docKey: `css:node:${selectedNode.id}`, projection: project(blocks), breakpoints }
  }

  const seen = new Set<string>()
  const classIds: string[] = []
  for (const node of Object.values(tree.nodes)) {
    for (const classId of node.classIds ?? []) {
      if (seen.has(classId)) continue
      seen.add(classId)
      classIds.push(classId)
    }
  }
  const blocks = orderRules(rules, usage, countMatches, classIds, pageAmbientRules(rules, pageRoot))
  const scopeKey =
    state.activeDocument?.kind === 'visualComponent'
      ? `vc:${state.activeDocument.vcId}`
      : `page:${state.activePageId ?? 'none'}`
  return { docKey: `css:${scopeKey}`, projection: project(blocks), breakpoints }
}
