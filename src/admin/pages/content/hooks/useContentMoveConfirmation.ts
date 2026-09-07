import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { DataRow } from '@core/data/schemas'
import { readTitleCell } from '@core/data/cells'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'

/** Collection identity is shared: moving content retracts every language and cancels every schedule. */
export function useContentMoveConfirmation() {
  const confirmMoveAction = useConfirmDelete()
  return (entry: DataRow | null, collectionName: string, commit: () => Promise<unknown>): Promise<void> => {
    if (!entry) return Promise.resolve()
    confirmMoveAction({
      title: `Move “${readTitleCell(entry.cells) || entry.slug || 'Untitled'}” to ${collectionName}?`,
      description: 'This moves the entry in every language. All language versions will go offline and every scheduled publication will be cancelled. You can publish each language again in the new collection.',
      confirmLabel: 'Move entry',
      alwaysConfirm: true,
      commit: () => {
        void commit().catch((error) => {
          console.error('[content] Could not move entry:', error)
          pushToast({ kind: 'error', title: 'Could not move entry', body: getErrorMessage(error, 'Move failed') })
        })
      },
    })
    return Promise.resolve()
  }
}
