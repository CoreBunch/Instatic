/**
 * canvasInlineTextEdit — shared guards for canvas inline text editing.
 *
 * Two ways to edit copy on the canvas:
 *   - Single click → select the element; edit in the Properties panel (Module section).
 *   - Double-click (or Enter while selected) → edit in place on the canvas element.
 */

import { registry } from '@core/module-engine'
import type { EditorStore } from '@site/store/types'
import { getActiveTree } from '@site/store/slices/selectionSlice'

/** True when `startInlineEdit` would open a session for this node. */
export function canNodeInlineTextEdit(state: EditorStore, nodeId: string): boolean {
  const node = getActiveTree(state)?.nodes[nodeId]
  if (!node) return false

  const def = registry.get(node.moduleId)
  const spec = def?.inlineTextEdit
  if (!spec) return false

  if (def?.editorRuntime?.sandbox && !def.trusted) return false
  if (node.children.length > 0) return false
  if (node.dynamicBindings?.[spec.prop]) return false

  return typeof node.props[spec.prop] === 'string'
}
