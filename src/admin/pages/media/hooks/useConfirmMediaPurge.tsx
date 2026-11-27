import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { CmsMediaAsset, CmsMediaUsageRef } from '@core/persistence/cmsMedia'
import { UsageWarningNotice } from '../components/UsageWarningNotice'
import { resolveUsageWarning } from '../utils/usageWarning'

/**
 * Confirm, then purge. What still uses the file is looked up BEFORE the dialog
 * opens, so the warning is part of what the operator reads rather than
 * something that shows up after they have decided.
 */
export function useConfirmMediaPurge(
  purgeAsset: (id: string) => Promise<void>,
  lookupUsage: (assetIds: string[]) => Promise<CmsMediaUsageRef[]>,
) {
  const confirmDelete = useConfirmDelete()
  return (asset: Pick<CmsMediaAsset, 'id' | 'filename'>) => {
    void (async () => {
      const warning = await resolveUsageWarning(lookupUsage, [asset.id])
      confirmDelete({
        title: `Delete "${asset.filename}" permanently?`,
        description: 'This removes the file and every generated size from disk. It cannot be undone.',
        details: <UsageWarningNotice warning={warning} />,
        confirmLabel: 'Delete permanently',
        alwaysConfirm: true,
        commit: () => void purgeAsset(asset.id),
      })
    })()
  }
}
