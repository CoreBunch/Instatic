/**
 * DataGridToolbar — the two-row header above the grid.
 *
 * Top row: table title + row-count subtitle, search box, and the "Add row"
 * action. Bottom row (publish-workflow tables only): the status/scope view
 * chips plus an active-sort indicator that clears the sort when clicked.
 */
import type { ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { SearchBar } from '@ui/components/SearchBar'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import type { DataTable } from '@core/data/schemas'
import { DataGridViewChips } from './DataGridViewChips'
import type {
  SortState,
  StatusCounts,
  StatusFilter,
  StatusViewChip,
} from './dataGridRows'
import styles from './DataGrid.module.css'

interface DataGridToolbarProps {
  table: DataTable
  /** Total row count (unfiltered) — drives the subtitle noun + count. */
  totalCount: number
  /** While loading, the subtitle stays empty so the skeleton owns the signal. */
  loading: boolean
  readOnly: boolean
  query: string
  onQueryChange: (q: string) => void
  onAddRow?: () => Promise<void> | void
  hasPublishWorkflow: boolean
  statusViewOrder: StatusViewChip[]
  statusFilter: StatusFilter
  onStatusFilterChange: (key: StatusFilter) => void
  statusCounts: StatusCounts
  sort: SortState | null
  /** Human label of the active sort field, or null when unsorted. */
  sortLabel: string | null
  onClearSort: () => void
}

export function DataGridToolbar({
  table,
  totalCount,
  loading,
  readOnly,
  query,
  onQueryChange,
  onAddRow,
  hasPublishWorkflow,
  statusViewOrder,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  sort,
  sortLabel,
  onClearSort,
}: DataGridToolbarProps): ReactElement {
  const totalNoun = totalCount === 1 ? table.singularLabel : table.pluralLabel
  const groupedByStatus =
    hasPublishWorkflow &&
    (statusFilter === 'all' || statusFilter === 'pages' || statusFilter === 'templates') &&
    totalCount > 0

  const subtitleParts: string[] = []
  if (!loading) subtitleParts.push(`${totalCount} ${totalNoun.toLowerCase()}`)
  if (groupedByStatus) subtitleParts.push('grouped by status')
  const subtitleText = subtitleParts.join(' · ')

  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarTop}>
        <div className={styles.titleBlock}>
          <span className={styles.title}>{table.pluralLabel}</span>
          <span className={styles.subtitle}>{subtitleText}</span>
        </div>

        <span className={styles.spacer} />

        <div className={styles.searchWrap}>
          <SearchBar
            value={query}
            onValueChange={onQueryChange}
            placeholder={`Search ${table.pluralLabel.toLowerCase()}…`}
            aria-label={`Search ${table.pluralLabel.toLowerCase()}`}
          />
        </div>

        {!readOnly && onAddRow != null && (
          <Button variant="primary" size="sm" onClick={() => { void onAddRow() }}>
            <PlusIcon size={12} aria-hidden="true" />
            Add row
          </Button>
        )}
      </div>

      {hasPublishWorkflow && (
        <div className={styles.toolbarBottom}>
          <DataGridViewChips
            views={statusViewOrder}
            active={statusFilter}
            counts={statusCounts}
            onSelect={onStatusFilterChange}
          />

          <span className={styles.toolbarSpacer} />

          {sort != null && sortLabel && (
            <Button
              variant="ghost"
              size="sm"
              shape="pill"
              className={styles.sortIndicator}
              onClick={onClearSort}
              aria-label={`Sorted by ${sortLabel} ${sort.dir === 'asc' ? 'ascending' : 'descending'} — click to clear`}
              tooltip="Clear sort"
            >
              <span className={styles.sortArrow} data-dir={sort.dir} aria-hidden="true">
                <ArrowDownIcon size={10} />
              </span>
              <span>{sortLabel}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
