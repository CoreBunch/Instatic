import { isGeneratedClassLocked, type CSSPropertyBag, type StyleRule } from '@core/page-tree'
import { selectSelectedNode, useEditorStore, type EditorStore } from './store'

export function selectStyleConditionId(state: EditorStore) {
  const id = state.activeConditionId
  return id && state.site?.conditions?.some((condition) => condition.id === id) ? id : null
}

export function selectStyleContextId(state: EditorStore) {
  const breakpoint = state.activeBreakpointId
  return selectStyleConditionId(state) ?? (breakpoint && breakpoint !== 'desktop' ? breakpoint : null)
}

export function storedRuleStyles(rule: StyleRule, contextId: string | null) {
  return contextId ? rule.contextStyles[contextId] ?? {} : rule.styles
}

export function ruleStyleTarget(rule: StyleRule, contextId: string | null) {
  const stored = storedRuleStyles(rule, contextId)
  return {
    stored,
    styles: contextId ? { ...rule.styles, ...stored } : stored,
    previewStyles: (styles: Partial<CSSPropertyBag>) =>
      useEditorStore.getState().setPreviewClassStyles({ classId: rule.id, contextId, styles }),
    clearPreview: () => useEditorStore.getState().clearPreviewClassStyles(rule.id),
    writeStyles(patch: Partial<CSSPropertyBag>) {
      const store = useEditorStore.getState()
      if (contextId) store.setClassContextStyles(rule.id, contextId, patch)
      else store.updateClassStyles(rule.id, patch)
    },
  }
}

export function inlineStyleTarget(nodeId: string, styles: Record<string, unknown> = {}) {
  return {
    stored: styles,
    styles,
    previewStyles: (patch: Partial<CSSPropertyBag>) => useEditorStore.getState().setPreviewInlineStyles(nodeId, patch),
    clearPreview: () => useEditorStore.getState().setPreviewInlineStyles(nodeId, null),
    writeStyles: (patch: Partial<CSSPropertyBag>) => useEditorStore.getState().setNodeInlineStyles(nodeId, patch),
  }
}

/** Canvas gestures capture the selected node and editing context at pointer-down. */
export function useActiveStyleTarget() {
  const node = useEditorStore(selectSelectedNode)
  const rule = useEditorStore((s) => s.activeClassId ? s.site?.styleRules[s.activeClassId] : undefined)
  const inline = useEditorStore((s) => s.inlineStyleEditing)
  const contextId = useEditorStore(selectStyleContextId)

  if (!node || node.locked) return null
  if (inline) {
    if (contextId) return null
    return { key: JSON.stringify([node.id]), ...inlineStyleTarget(node.id, node.inlineStyles) }
  }
  if (!rule || isGeneratedClassLocked(rule)) return null
  return { key: JSON.stringify([node.id, rule.id, contextId]), ...ruleStyleTarget(rule, contextId) }
}

export type ActiveStyleTarget = NonNullable<ReturnType<typeof useActiveStyleTarget>>
