/**
 * DataGridBulkActionBar — the floating action bar shown while one or more
 * rows are selected. Surfaces publish/draft (publish-workflow tables only),
 * export, and delete actions over the current selection.
 */
import type { ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { FloatingActionBar } from '@ui/components/FloatingActionBar'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import type { DataRowStatus } from '@core/data/schemas'
import { useBranchPublishGate } from '@admin/state/branchStore'
import styles from './DataGrid.module.css'

interface DataGridBulkActionBarProps {
  selectedCount: number
  hasPublishWorkflow: boolean
  onClearSelection: () => void
  /** Publish/draft buttons render only when both this and the workflow flag are set. */
  onSetStatus?: (status: DataRowStatus) => void
  onExport?: () => void
  onDelete?: () => void
}

export function DataGridBulkActionBar({
  selectedCount,
  hasPublishWorkflow,
  onClearSelection,
  onSetStatus,
  onExport,
  onDelete,
}: DataGridBulkActionBarProps): ReactElement {
  // Publishing only exists on main — the bulk publish stays visible but
  // disabled with the reason while a branch is active.
  const branchGate = useBranchPublishGate()
  return (
    <FloatingActionBar
      open={selectedCount > 0}
      ariaLabel="Bulk row actions"
      label={<><strong>{selectedCount}</strong> selected</>}
      onClose={onClearSelection}
      closeLabel="Clear selection"
    >
      {hasPublishWorkflow && onSetStatus != null && (
        <>
          <Button
            variant="ghost"
            size="sm"
            shape="pill"
            className={styles.bulkBarBtn}
            disabled={branchGate.onBranch}
            tooltip={branchGate.reason ?? undefined}
            onClick={() => onSetStatus('published')}
          >
            Publish
          </Button>
          <Button
            variant="ghost"
            size="sm"
            shape="pill"
            className={styles.bulkBarBtn}
            onClick={() => onSetStatus('draft')}
          >
            Move to draft
          </Button>
        </>
      )}
      {onExport != null && (
        <Button
          variant="ghost"
          size="sm"
          shape="pill"
          className={styles.bulkBarBtn}
          onClick={onExport}
        >
          <ArrowDownIcon size={11} aria-hidden="true" />
          Export
        </Button>
      )}
      {onDelete != null && (
        <Button
          variant="ghost"
          size="sm"
          shape="pill"
          tone="danger"
          dangerHover
          className={styles.bulkBarBtn}
          onClick={onDelete}
        >
          <TrashSolidIcon size={11} aria-hidden="true" />
          Delete
        </Button>
      )}
    </FloatingActionBar>
  )
}
