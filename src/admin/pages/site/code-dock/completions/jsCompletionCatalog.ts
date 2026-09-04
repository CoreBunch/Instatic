/**
 * What the JS panel completes beyond JavaScript itself: the page's real
 * class names and element ids, for the selector strings a page script
 * targets elements with — the selected element's own first.
 */
import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'
import { normalizeHtmlAttributes } from '@core/htmlAttributes'
import type { JsCompletionCatalog } from '@site/code-editor/completionCatalog'

export interface JsCompletionInputs {
  site: SiteDocument
  tree: NodeTree<PageNode>
  selectedNodeId: string | null
}

function nodeClassNames(site: SiteDocument, node: PageNode): string[] {
  const names: string[] = []
  for (const classId of node.classIds ?? []) {
    const rule = site.styleRules[classId]
    if (rule && rule.kind === 'class') names.push(rule.name)
  }
  return names
}

function nodeElementId(node: PageNode): string | null {
  const id = normalizeHtmlAttributes(node.props.htmlAttributes).id
  return id && id.trim() !== '' ? id.trim() : null
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

export function deriveJsCompletionCatalog(inputs: JsCompletionInputs): JsCompletionCatalog {
  const { site, tree, selectedNodeId } = inputs
  const selected = selectedNodeId ? tree.nodes[selectedNodeId] : undefined
  const selectedClasses = selected ? unique(nodeClassNames(site, selected)) : []
  const selectedId = selected ? nodeElementId(selected) : null
  const classes: string[] = [...selectedClasses]
  const ids: string[] = selectedId ? [selectedId] : []
  for (const node of Object.values(tree.nodes)) {
    classes.push(...nodeClassNames(site, node))
    const id = nodeElementId(node)
    if (id) ids.push(id)
  }
  return {
    kind: 'js',
    classes: unique(classes),
    ids: unique(ids),
    selectedClasses,
    selectedIds: selectedId ? [selectedId] : [],
  }
}
