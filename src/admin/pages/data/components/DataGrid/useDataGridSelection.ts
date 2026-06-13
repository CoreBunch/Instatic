/**
 * useDataGridSelection — bulk-select state for the DataGrid.
 *
 * Owns the set of checked row ids and derives the header-checkbox state from
 * the currently *visible* rows (selection of rows hidden by the active filter
 * is preserved but doesn't drive the header checkbox).
 */
import { useState } from 'react'
import type { DataRow } from '@core/data/schemas'

interface DataGridSelection {
  checkedIds: Set<string>
  /** How many of the currently-visible rows are checked. */
  checkedVisibleCount: number
  /** All visible rows are checked (and there is at least one). */
  allChecked: boolean
  /** Some — but not all — visible rows are checked. */
  someChecked: boolean
  /**
   * The Checkbox primitive doesn't style `:indeterminate`, so the header
   * checkbox renders as "checked" whenever ANY visible row is selected.
   */
  headerChecked: boolean
  toggleRow: (rowId: string, next: boolean) => void
  /** Select / deselect every currently-visible row. */
  toggleAll: (next: boolean) => void
  clearSelection: () => void
}

export function useDataGridSelection(visibleRows: DataRow[]): DataGridSelection {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set())

  const visibleIdSet = new Set(visibleRows.map((r) => r.id))
  let checkedVisibleCount = 0
  for (const id of checkedIds) if (visibleIdSet.has(id)) checkedVisibleCount += 1

  const allChecked = checkedVisibleCount > 0 && checkedVisibleCount === visibleRows.length
  const someChecked = checkedVisibleCount > 0 && checkedVisibleCount < visibleRows.length
  const headerChecked = allChecked || someChecked

  function toggleRow(rowId: string, next: boolean): void {
    setCheckedIds((prev) => {
      const out = new Set(prev)
      if (next) out.add(rowId)
      else out.delete(rowId)
      return out
    })
  }

  function toggleAll(next: boolean): void {
    setCheckedIds((prev) => {
      const out = new Set(prev)
      for (const r of visibleRows) {
        if (next) out.add(r.id)
        else out.delete(r.id)
      }
      return out
    })
  }

  function clearSelection(): void {
    setCheckedIds(new Set())
  }

  return {
    checkedIds,
    checkedVisibleCount,
    allChecked,
    someChecked,
    headerChecked,
    toggleRow,
    toggleAll,
    clearSelection,
  }
}
