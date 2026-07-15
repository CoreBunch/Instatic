/**
 * DataGridEmptyState — the "no rows" message shown inside the grid.
 *
 * Distinguishes a genuinely-empty table ("Add the first row") from an active
 * filter that matched nothing ("Try clearing the search"). The outer span
 * fills the full grid row; the inner EmptyState pins to the left edge during
 * horizontal scroll (see `.emptyStateInner` / `.emptyStateSpan`).
 */
import type { ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import type { DataTable } from '@core/data/schemas'
import styles from './DataGrid.module.css'

interface DataGridEmptyStateProps {
  table: DataTable
  /** True when a search query or non-'all' status filter is narrowing the view. */
  filtered: boolean
  readOnly: boolean
  onAddRow?: () => Promise<void> | void
}

export function DataGridEmptyState({
  table,
  filtered,
  readOnly,
  onAddRow,
}: DataGridEmptyStateProps): ReactElement {
  const noun = table.pluralLabel.toLowerCase()
  const canAdd = !readOnly && onAddRow != null
  return (
    <div className={styles.emptyStateSpan}>
      <EmptyState
        plain
        title={filtered ? `No ${noun} match this view` : `No ${noun} yet`}
        description={
          !canAdd
            ? undefined
            : filtered
              ? 'Try clearing the search or switching views.'
              : 'Add the first row to get started.'
        }
        action={
          canAdd && !filtered ? (
            <Button variant="secondary" size="sm" onClick={() => { void onAddRow() }}>
              <PlusIcon size={12} aria-hidden="true" />
              Add row
            </Button>
          ) : undefined
        }
        className={styles.emptyStateInner}
      />
    </div>
  )
}
