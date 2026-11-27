import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'

/**
 * Confirm, then purge. `ids` defaults to the one asset; the media canvas's
 * context menu passes the whole selection it acts on, and the dialog then
 * counts the files instead of naming one.
 */
export function useConfirmMediaPurge(purgeAsset: (id: string) => Promise<void>) {
  const confirmDelete = useConfirmDelete()
  return (asset: Pick<CmsMediaAsset, 'id' | 'filename'>, ids: readonly string[] = [asset.id]) => {
    const many = ids.length > 1
    confirmDelete({
      title: many ? `Delete ${ids.length} files permanently?` : `Delete "${asset.filename}" permanently?`,
      description: many
        ? 'This removes every one of these files and all their generated sizes from disk. It cannot be undone.'
        : 'This removes the file and every generated size from disk. It cannot be undone.',
      confirmLabel: many ? `Delete ${ids.length} files` : 'Delete permanently',
      alwaysConfirm: true,
      commit: () => {
        for (const id of ids) void purgeAsset(id)
      },
    })
  }
}
