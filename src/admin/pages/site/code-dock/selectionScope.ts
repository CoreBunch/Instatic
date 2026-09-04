/**
 * The editor-state fields that scope the HTML and CSS panels: the active
 * document and the canvas selection. Both panels select exactly this shape
 * (shallow-comparable) and re-project only when one of them changes.
 */
import type { EditorStore } from '@site/store/types'

export type SelectionScopeInputs = Pick<
  EditorStore,
  'site' | 'activeDocument' | 'activePageId' | 'selectedNodeId'
>

export const selectSelectionScope = (s: SelectionScopeInputs): SelectionScopeInputs => ({
  site: s.site,
  activeDocument: s.activeDocument,
  activePageId: s.activePageId,
  selectedNodeId: s.selectedNodeId,
})

export function selectionScopeEqual(a: SelectionScopeInputs, b: SelectionScopeInputs): boolean {
  return (
    a.site === b.site
    && a.activeDocument === b.activeDocument
    && a.activePageId === b.activePageId
    && a.selectedNodeId === b.selectedNodeId
  )
}
