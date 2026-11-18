/** useClassPickerDerivedState — derives suggestions, pills, and canvas state for the ClassPicker. */

import { useEffect, useState } from 'react'
import { isUserVisibleClass, type PageNode, type StyleRule } from '@core/page-tree'
import { findRenderedCanvasNodeElement } from '@site/canvas/canvasNodeLookup'
import { useClassPickerSuggestions } from './useClassPickerSuggestions'
import { deriveSelectorPickerModel } from './selectorPickerModel'

function isClassRule(rule: StyleRule): boolean {
  return !rule.kind || rule.kind === 'class'
}

/** How many frames to wait for a just-inserted node to reach the canvas. */
const MOUNT_WAIT_FRAMES = 30

/**
 * The node's element on the canvas. A node that was just inserted is selected
 * before the canvas frame has rendered it, so a miss is looked up again on the
 * following frames; without that its matching selectors stay hidden until
 * some later edit happens to re-render the panel.
 */
function useRenderedCanvasNodeElement(nodeId: string): HTMLElement | null {
  const rendered = findRenderedCanvasNodeElement(nodeId)
  const [late, setLate] = useState<{ nodeId: string; element: HTMLElement } | null>(null)
  const missing = rendered === null

  useEffect(() => {
    if (!missing) return
    let frame = 0
    let tries = 0
    const look = () => {
      const element = findRenderedCanvasNodeElement(nodeId)
      if (element) setLate({ nodeId, element })
      else if (++tries < MOUNT_WAIT_FRAMES) frame = requestAnimationFrame(look)
    }
    frame = requestAnimationFrame(look)
    return () => cancelAnimationFrame(frame)
  }, [nodeId, missing])

  if (rendered) return rendered
  return late?.nodeId === nodeId && late.element.isConnected ? late.element : null
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
  const selectedElement = useRenderedCanvasNodeElement(nodeId)
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
