/** useClassPickerDerivedState — derives suggestions, pills, and canvas state for the ClassPicker. */

import { isUserVisibleClass, type PageNode, type StyleRule } from '@core/page-tree'
import { findRenderedCanvasNodeElement } from '@site/canvas/canvasNodeLookup'
import { useClassPickerSuggestions } from './useClassPickerSuggestions'
import { deriveSelectorPickerModel } from './selectorPickerModel'

function isClassRule(rule: StyleRule): boolean {
  return !rule.kind || rule.kind === 'class'
}

export function useClassPickerDerivedState({
  site,
  node,
  nodeId,
  activeClassId,
  inlineStyleEditing,
  query,
  highlightedIndex,
}: {
  site: { styleRules: Record<string, StyleRule> } | null
  node: PageNode | null
  nodeId: string
  activeClassId: string | null
  inlineStyleEditing: boolean
  query: string
  highlightedIndex: number
}) {
  const assignedIds = node?.classIds ?? []
  const visibleAssignedIds = assignedIds.filter((id) => isUserVisibleClass(site?.styleRules[id]))
  const nodeHasInlineStyles = !!node?.inlineStyles && Object.keys(node.inlineStyles).length > 0
  const allRules = Object.values(site?.styleRules ?? {}).filter(isUserVisibleClass)
  const allClasses = allRules.filter(isClassRule)
  const visibleRuleRegistry = Object.fromEntries(allRules.map((rule) => [rule.id, rule]))
  const selectedElement = findRenderedCanvasNodeElement(nodeId)
  const selectorModel = deriveSelectorPickerModel({
    rules: visibleRuleRegistry,
    node,
    selectedElement,
    activeRuleId: inlineStyleEditing ? null : activeClassId,
  })
  const ambientSelectorItems = selectorModel.suggestions.filter((item) => item.rule.kind === 'ambient')
  const suggestions = useClassPickerSuggestions({
    allClasses,
    assignedIds,
    selectorItems: ambientSelectorItems,
    query,
    highlightedIndex,
  })
  const hasSuggestionRows = (
    suggestions.isEmptyQuery
      ? suggestions.candidates.length > 0
      : suggestions.filteredSuggestions.length > 0
  ) || suggestions.selectorSuggestions.length > 0

  return {
    visibleAssignedIds,
    showInlinePill: nodeHasInlineStyles || inlineStyleEditing,
    selectedElement,
    selectorModel,
    hasSuggestionRows,
    highlightedSelectorId: suggestions.highlightedSelectorItem?.rule.id ?? null,
    ...suggestions,
  }
}
