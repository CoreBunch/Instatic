import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DataRow, DataRowCells } from '@core/data/schemas'
import { getErrorMessage } from '@core/utils/errorMessage'

const DEBOUNCE_MS = 700

interface DataRowDraft {
  cells: DataRowCells
  isDirty: boolean
  isSaving: boolean
  saveError: string | null
  setCell: (fieldId: string, value: unknown) => void
  /** Replace the entire cells record (used when the selected row changes). */
  setCells: (cells: DataRowCells) => void
  /** Force an immediate save, cancelling any pending debounce timer. */
  flush: () => Promise<void>
  /** Reset to the saved state, discarding any pending changes. */
  reset: (cells: DataRowCells) => void
}

export function useDataRowDraft(
  row: DataRow | null,
  onSave: (rowId: string, cells: DataRowCells) => Promise<DataRow>,
): DataRowDraft {
  const [trackedRowId, setTrackedRowId] = useState<string | null>(row?.id ?? null)
  const [cells, setCellsState] = useState<DataRowCells>(row?.cells ?? {})
  const [savedCells, setSavedCells] = useState<DataRowCells>(row?.cells ?? {})
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track cells in a ref so debounced save always captures the latest value.
  const cellsRef = useRef<DataRowCells>(row?.cells ?? {})

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  // Render-time STATE reset when row id changes (setState only — no ref writes
  // during render, which the React hooks lint rule disallows).
  if (trackedRowId !== (row?.id ?? null)) {
    setTrackedRowId(row?.id ?? null)
    const initial = row?.cells ?? {}
    setCellsState(initial)
    setSavedCells(initial)
    setSaveError(null)
  }

  // Sync cellsRef and cancel any pending debounce when the row id changes.
  // useEffectEvent reads the latest `row` so the effect only fires on row id
  // change — same-row cell edits must NOT reset the ref or cancel the
  // pending debounce, which is exactly what the dep array enforces here.
  const resetForNewRow = useEffectEvent(() => {
    cellsRef.current = row?.cells ?? {}
    clearTimer()
  })
  useEffect(() => {
    resetForNewRow()
  }, [row?.id])

  // Sync the cells ref whenever state updates so the debounced save always
  // captures the latest snapshot.
  useEffect(() => {
    cellsRef.current = cells
  }, [cells])

  // Clean up any pending timer on unmount.
  useEffect(() => {
    return () => clearTimer()
  }, [])

  async function performSave(rowId: string, snapshot: DataRowCells) {
    setIsSaving(true)
    setSaveError(null)
    try {
      const saved = await onSave(rowId, snapshot)
      setSavedCells(saved.cells)
    } catch (err) {
      console.error('[data-row-draft] Save failed:', err)
      setSaveError(getErrorMessage(err, 'Could not save row'))
    } finally {
      setIsSaving(false)
    }
  }

  function scheduleDebounced(rowId: string) {
    clearTimer()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void performSave(rowId, cellsRef.current)
    }, DEBOUNCE_MS)
  }

  // Plain functions — React Compiler (when enabled) memoizes automatically.
  function setCell(fieldId: string, value: unknown) {
    if (!row?.id) return
    const rowId = row.id
    const next = { ...cellsRef.current, [fieldId]: value }
    cellsRef.current = next
    setCellsState(next)
    scheduleDebounced(rowId)
  }

  function setCells(next: DataRowCells) {
    clearTimer()
    cellsRef.current = next
    setCellsState(next)
    setSavedCells(next)
    setSaveError(null)
  }

  async function flush() {
    if (!row?.id) return
    clearTimer()
    await performSave(row.id, cellsRef.current)
  }

  function reset(next: DataRowCells) {
    clearTimer()
    cellsRef.current = next
    setCellsState(next)
    setSavedCells(next)
    setSaveError(null)
  }

  const isDirty = JSON.stringify(cells) !== JSON.stringify(savedCells)

  return {
    cells,
    isDirty,
    isSaving,
    saveError,
    setCell,
    setCells,
    flush,
    reset,
  }
}
