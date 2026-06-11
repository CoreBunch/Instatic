import { useEditorStore, selectActiveCanvasPage } from '@site/store/store'
import { resolveInsertLocation, type InsertLocation } from '@site/store/insertLocation'
import { pushToast } from '@ui/components/Toast'
import type { ModuleInserterItem } from '@site/module-picker/moduleInserterModel'
import { useInsertModule } from './useInsertModule'
import { useInsertPreset } from './useInsertPreset'

/**
 * Shared handler for the module inserter dialog's `onInsertItem` callback.
 *
 * Inserts the picked module / layout preset / Visual Component into the active
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
  const insertModule = useInsertModule()
  const insertPreset = useInsertPreset()

  const insertLayoutAction = useEditorStore((s) => s.insertLayout)

  const insertVC = (vcId: string, explicitTarget?: InsertLocation): boolean => {
    if (!canvasPage) return false
    // Same target → location resolution as every other insert flow: explicit
    // selection acts as the target, no selection drops at root, leaf targets
    // become a sibling-after under their parent (see resolveInsertLocation).
    const location =
      explicitTarget ??
      resolveInsertLocation(canvasPage, selectedNodeId ?? canvasPage.rootNodeId)
    if (!location) return false
    insertComponentRef(location.parentId, vcId, location.index)
    return true
  }

  return (
    item: ModuleInserterItem,
    target: InsertLocation | undefined,
    mode: 'click' | 'drop',
  ): boolean => {
    const inserted =
      item.kind === 'module'
        ? Boolean(insertModule(item.module, target))
        : item.kind === 'layout'
          ? Boolean(insertPreset(item.preset, target))
          : item.kind === 'savedLayout'
            ? Boolean(insertLayoutAction(item.id, target))
            : item.kind === 'component'
              ? insertVC(item.id, target)
              : false

    if (!inserted) return false

    pushToast({
      kind: 'success',
      title: mode === 'drop' ? `Placed ${item.name}` : `Inserted ${item.name}`,
      body: mode === 'drop' ? 'Dropped on canvas.' : 'Inserted at the current selection.',
      location: 'module-inserter',
    })
    return true
  }
}
