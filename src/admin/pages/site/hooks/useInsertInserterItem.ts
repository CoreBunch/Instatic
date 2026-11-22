import { isMobileViewport } from '@admin/lib/mobileViewport'
import { revealSelectedCanvasNode } from '@site/canvas/revealSelectedCanvasNode'
import type { SelectNodeOptions } from '@site/store/slices/selectionSlice'
import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { resolveInsertLocation, type InsertLocation } from '@site/store/insertLocation'
import { pushToast } from '@ui/components/Toast'
import type { ModuleInserterItem } from '@site/module-picker/moduleInserterModel'
import { useInsertModule } from './useInsertModule'

/**
 * Shared handler for the module inserter dialog's `onInsertItem` callback.
 *
 * Inserts the picked module / saved layout / Visual Component into the active
 * canvas document and surfaces a success toast. Both inserter entry points use
 * it — the main toolbar "+ Add" button (`ModulePickerDropdown`) and the canvas
 * selection toolbar's "Insert module" action — so the two flows stay identical.
 *
 * Target resolution: when the dialog passes an explicit drop `target` it is
 * used verbatim; otherwise the shared insert hooks resolve the location from
 * the current selection via `resolveInsertLocation` (container targets nest the
 * new node as a last child, leaf targets get a sibling-after insertion).
 */
export function useInsertInserterItem() {
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const insertComponentRef = useEditorStore((s) => s.insertComponentRef)
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectNode = useEditorStore((s) => s.selectNode)
  const insertModule = useInsertModule()

  const insertLayoutAction = useEditorStore((s) => s.insertLayout)

  const insertVC = (vcId: string, explicitTarget?: InsertLocation) => {
    if (!canvasPage) return null
    // Same target → location resolution as every other insert flow: explicit
    // selection acts as the target, no selection drops at root, leaf targets
    // become a sibling-after under their parent (see resolveInsertLocation).
    const location =
      explicitTarget ??
      resolveInsertLocation(canvasPage, selectedNodeId ?? canvasPage.rootNodeId)
    return location ? insertComponentRef(location.parentId, vcId, location.index) : null
  }

  return (
    item: ModuleInserterItem,
    target: InsertLocation | undefined,
    mode: 'click' | 'drop',
  ): boolean => {
    const phone = isMobileViewport()
    const options: SelectNodeOptions = { propertiesPanel: phone ? 'close' : 'open' }
    const nodeId = item.kind === 'module'
      ? insertModule(item.module, target, options)
      : item.kind === 'savedLayout'
        ? insertLayoutAction(item.id, target, options)
        : insertVC(item.id, target)
    if (!nodeId) return false

    if (phone) {
      if (item.kind === 'component') selectNode(nodeId, undefined, options)
      requestAnimationFrame(() => revealSelectedCanvasNode(nodeId))
    }

    pushToast({
      kind: 'success',
      title: mode === 'drop' ? `Placed ${item.name}` : `Inserted ${item.name}`,
      body: mode === 'drop' ? 'Dropped on canvas.' : 'Inserted at the current selection.',
      location: 'module-inserter',
    })
    return true
  }
}
