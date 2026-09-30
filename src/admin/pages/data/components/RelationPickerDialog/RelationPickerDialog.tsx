import { useState } from 'react'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { listCmsDataRows } from '@core/persistence/cmsData'
import { readDisplayTitle } from '@core/data/cells'
import type { DataRow, DataTable } from '@core/data/schemas'
import styles from './RelationPickerDialog.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RelationPickerDialogProps {
  open: boolean
  onClose: () => void
  targetTable: DataTable | null
  currentValue: string | string[] | null
  allowMultiple: boolean
  onPick: (next: string | string[] | null) => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSelection(value: string | string[] | null): Set<string> {
  if (!value) return new Set()
  if (Array.isArray(value)) return new Set(value)
  return new Set([value])
}

function buildResult(selected: Set<string>, allowMultiple: boolean): string | string[] | null {
  if (selected.size === 0) return null
  const ids = [...selected]
  return allowMultiple ? ids : (ids[0] ?? null)
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RelationPickerDialog({
  open,
  onClose,
  targetTable,
  currentValue,
  allowMultiple,
  onPick,
}: RelationPickerDialogProps) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => normalizeSelection(currentValue))

  // Load rows when the dialog opens (or the target table changes); resolve to
  // an empty list while closed so nothing is fetched in the background.
  const { data, loading, error: loadError } = useAsyncResource(
    () => (open && targetTable ? listCmsDataRows(targetTable.id) : Promise.resolve<DataRow[]>([])),
    [open, targetTable],
    { fallbackError: 'Failed to load rows' },
  )
  const rows: DataRow[] = data ?? []

  // Re-sync selection when the dialog opens or currentValue changes. Done by
  // adjusting state during render (tracking the previous open/value) rather
  // than in an effect — the React-recommended pattern, which avoids the
  // cascading re-render an effect-driven setState would trigger.
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevCurrentValue, setPrevCurrentValue] = useState(currentValue)
  if (open !== prevOpen || currentValue !== prevCurrentValue) {
    setPrevOpen(open)
    setPrevCurrentValue(currentValue)
    if (open) setSelected(normalizeSelection(currentValue))
  }

  const filteredRows = (() => {
    if (!search.trim()) return rows
    const q = search.trim().toLowerCase()
    return rows.filter((row) =>
      readDisplayTitle(row.cells, targetTable).toLowerCase().includes(q),
    )
  })()

  function toggleRow(rowId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) {
        next.delete(rowId)
      } else {
        if (!allowMultiple) {
          next.clear()
        }
        next.add(rowId)
      }
      return next
    })
  }

  function handleConfirm() {
    onPick(buildResult(selected, allowMultiple))
    setSearch('')
    onClose()
  }

  function handleClose() {
    setSearch('')
    onClose()
  }

  const title =
    targetTable == null
      ? 'Pick relation'
      : allowMultiple
        ? `Pick ${targetTable.pluralLabel}`
        : `Pick ${targetTable.singularLabel}`

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleConfirm}
            disabled={targetTable == null}
          >
            Confirm
          </Button>
        </>
      }
    >
      {targetTable == null ? (
        <EmptyState
          title="No target table configured"
          description="Set a target table on the relation field to pick rows."
          variant="centered"
        />
      ) : (
        <div className={styles.body}>
          <SearchBar
            value={search}
            onValueChange={setSearch}
            placeholder={`Search ${targetTable.pluralLabel.toLowerCase()}…`}
            className={styles.search}
          />
          <p className={styles.selectionSummary} role="status">
            {allowMultiple ? `${selected.size} selected · Choose one or more entries` : 'Choose one entry'}
          </p>

          {loading && <SkeletonBlock minHeight={140} ariaLabel="Loading rows" />}

          {!loading && loadError && (
            <EmptyState
              title="Could not load rows"
              description={loadError}
              variant="card"
            />
          )}

          {!loading && !loadError && filteredRows.length === 0 && (
            <EmptyState
              title={search ? 'No matches' : `No ${targetTable.pluralLabel.toLowerCase()} yet`}
              description={search ? 'Try a different search term.' : undefined}
              variant="card"
            />
          )}

          {!loading && !loadError && filteredRows.length > 0 && (
            <div className={styles.list} role="group" aria-label={`Select ${targetTable.pluralLabel}`}>
              {filteredRows.map((row) => {
                const displayValue = readDisplayTitle(row.cells, targetTable)
                const isSelected = selected.has(row.id)
                const rowLabel = (
                  <span className={styles.rowText}>
                    <span className={styles.rowLabel}>{displayValue}</span>
                    {targetTable.kind === 'postType' && (
                      <span className={styles.rowStatus}>{row.status === 'published' ? 'Published' : row.status === 'unpublished' ? 'Unpublished' : 'Draft'}</span>
                    )}
                  </span>
                )
                if (allowMultiple) {
                  return (
                    <label key={row.id} className={styles.row} data-selected={isSelected}>
                      <Checkbox checked={isSelected} onCheckedChange={() => toggleRow(row.id)} aria-label={displayValue} />
                      {rowLabel}
                    </label>
                  )
                }
                return (
                  <Button
                    key={row.id}
                    variant="ghost"
                    size="sm"
                    pressed={isSelected}
                    fullWidth
                    align="start"
                    type="button"
                    className={styles.row}
                    data-selected={isSelected}
                    onClick={() => toggleRow(row.id)}
                  >
                    <span className={styles.singleMarker} aria-hidden="true">{isSelected && <CheckIcon size={16} />}</span>
                    {rowLabel}
                  </Button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}
