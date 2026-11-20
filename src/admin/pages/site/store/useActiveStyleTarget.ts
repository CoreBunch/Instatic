/**
 * useActiveStyleTarget — "where does a style edit go right now?", in one place.
 *
 * The Properties panel already resolves this: an edit lands on the active
 * class rule (optionally on the active breakpoint / condition override) or,
 * when the user is styling a node inline, on that node's `inlineStyles`. The
 * on-canvas gradient gizmo has to hit exactly the same target — a second copy
 * of that resolution would drift the moment either side changed.
 *
 * So the rule lives here and both callers consume it. The hook returns a
 * `writeStyles(patch)` that applies a whole patch in ONE store commit (one
 * undo entry), plus the resolved `styles` bag so a caller can read the value
 * it is about to edit from the same place it will write it.
 *
 * `null` means there is no unambiguous target — no selection, or a selected
 * node with neither an active class nor inline-style editing. Callers must
 * treat that as "don't offer the affordance" rather than guessing.
 */

import { isGeneratedClassLocked, type CSSPropertyBag } from '@core/page-tree'
import { getActiveStyleTab } from '../panels/PropertiesPanel/cssControlTypes'
import { selectSelectedNode, useEditorStore } from './store'

export interface ActiveStyleTarget {
  /** Stable identity for cancelling a captured drag when the edit target changes. */
  key: string
  previewStyles: (patch: Partial<CSSPropertyBag>) => void
  clearPreview: () => void
  /** The bag an edit would land in, merged over base for context overrides. */
  styles: Record<string, unknown>
  /** Apply several properties in one commit. `undefined` clears a key. */
  writeStyles: (patch: Partial<CSSPropertyBag>) => void
}

export function useActiveStyleTarget(): ActiveStyleTarget | null {
  const nodeId = useEditorStore((s) => s.selectedNodeId)
  const activeClassId = useEditorStore((s) => s.activeClassId)
  const inlineStyleEditing = useEditorStore((s) => s.inlineStyleEditing)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  // Same validity check StyleRuleComposer applies: a stale condition id (the
  // condition was deleted) falls back to viewport editing rather than writing
  // into a context that no longer exists.
  const activeConditionId = useEditorStore((s) => {
    const id = s.activeConditionId
    if (id === null) return null
    const conditions = s.site?.conditions
    return conditions && conditions.some((c) => c.id === id) ? id : null
  })
  const rule = useEditorStore((s) => (activeClassId ? s.site?.styleRules[activeClassId] : undefined))
  const selectedNode = useEditorStore(selectSelectedNode)

  const setPreviewInlineStyles = useEditorStore((s) => s.setPreviewInlineStyles)
  const setPreviewClassStyles = useEditorStore((s) => s.setPreviewClassStyles)
  const clearPreviewClassStyles = useEditorStore((s) => s.clearPreviewClassStyles)
  const updateClassStyles = useEditorStore((s) => s.updateClassStyles)
  const setClassContextStyles = useEditorStore((s) => s.setClassContextStyles)
  const setNodeInlineStyles = useEditorStore((s) => s.setNodeInlineStyles)

  // Inline editing is mutually exclusive with an active class (selectionSlice
  // keeps them that way), and it wins when set — it is the explicit choice.
  if (!selectedNode || selectedNode.locked) return null
  if (nodeId && inlineStyleEditing) {
    // Inline styles are BASE-ONLY — a real `style=""` attribute cannot be
    // media-queried, so on a non-base breakpoint/condition context there is
    // no writable target: a write would land in the base bag and change
    // EVERY breakpoint. Callers hide the affordance instead (author decision
    // 2026-08-31: block + hint, never leak silently).
    if (getActiveStyleTab(activeBreakpointId) !== 'base' || activeConditionId !== null) {
      return null
    }
    const styles = selectedNode?.inlineStyles ?? {}
    return {
      key: JSON.stringify([nodeId]),
      previewStyles: (patch) => setPreviewInlineStyles(nodeId, patch),
      clearPreview: () => setPreviewInlineStyles(nodeId, null),
      styles,
      writeStyles: (patch) => setNodeInlineStyles(nodeId, patch),
    }
  }

  if (!nodeId || !activeClassId || !rule || isGeneratedClassLocked(rule)) return null

  // Same base/override mapping the Properties panel applies — the desktop
  // viewport writes BASE styles, not a 'desktop' context override.
  const activeTab = getActiveStyleTab(activeBreakpointId)
  const contextId = activeConditionId ?? (activeTab !== 'base' ? activeTab : null)
  const storedStyles = contextId ? (rule.contextStyles[contextId] ?? {}) : rule.styles
  // A context override paints ON TOP of base, so the value in effect — and
  // therefore the one the gizmo must visualise — is the merge.
  const styles: Record<string, unknown> = contextId
    ? { ...rule.styles, ...storedStyles }
    : rule.styles

  return {
    key: JSON.stringify([nodeId, activeClassId, contextId]),
    previewStyles: (patch) => setPreviewClassStyles({ classId: activeClassId, contextId, styles: patch }),
    clearPreview: () => clearPreviewClassStyles(activeClassId),
    styles,
    writeStyles: (patch) => {
      if (contextId) setClassContextStyles(activeClassId, contextId, patch)
      else updateClassStyles(activeClassId, patch)
    },
  }
}
