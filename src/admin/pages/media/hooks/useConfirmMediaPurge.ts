import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'

export function useConfirmMediaPurge(purgeAsset: (id: string) => Promise<void>) {
  const confirmDelete = useConfirmDelete()
  return (asset: Pick<CmsMediaAsset, 'id' | 'filename'>) => {
    confirmDelete({
      title: `Delete "${asset.filename}" permanently?`,
      description: 'This removes the file and every generated size from disk. It cannot be undone.',
      confirmLabel: 'Delete permanently',
      alwaysConfirm: true,
      commit: () => void purgeAsset(asset.id),
    })
  }
}
