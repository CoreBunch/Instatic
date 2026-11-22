import { useEffect, useRef, useState } from 'react'
import type { DataRow, DataRowCells } from '@core/data/schemas'
import { getErrorMessage } from '@core/utils/errorMessage'

const DEBOUNCE_MS = 700

/** RowDetail is keyed by row id, so each open row owns its timer and save queue. */
export function useDataRowDraft(
  row: DataRow,
  onSave: (rowId: string, cells: DataRowCells) => Promise<DataRow>,
) {
  const [cells, setCells] = useState(row.cells)
  const [savedCells, setSavedCells] = useState(row.cells)
  const [isSaving, setIsSaving] = useState(false)
  const [hasSavedChanges, setHasSavedChanges] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const latest = useRef(row.cells)
  const persisted = useRef(row.cells)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<Promise<DataRow | null> | null>(null)

  function clearTimer() {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  useEffect(() => clearTimer, [])

  async function saveChanges(): Promise<DataRow | null> {
    setIsSaving(true)
    setSaveError(null)
    try {
      // A blur, debounce and Back to rows can all request the same save.
      // Finish one write before sending any edits made while it was in flight.
      let savedRow = row
      while (latest.current !== persisted.current) {
        const snapshot = latest.current
        savedRow = await onSave(row.id, snapshot)
        persisted.current = snapshot
        setSavedCells(snapshot)
        setHasSavedChanges(true)
      }
      return savedRow
    } catch (err) {
      console.error('[data-row-draft] Save failed:', err)
      setSaveError(getErrorMessage(err, 'Could not save row'))
      return null
    } finally {
      inFlight.current = null
      setIsSaving(false)
    }
  }

  function flush(): Promise<DataRow | null> {
    clearTimer()
    if (inFlight.current) return inFlight.current
    if (latest.current === persisted.current) return Promise.resolve(row)
    inFlight.current = saveChanges()
    return inFlight.current
  }

  function setCell(fieldId: string, value: unknown) {
    const next = { ...latest.current, [fieldId]: value }
    latest.current = next
    setCells(next)
    clearTimer()
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS)
  }

  return { cells, isDirty: cells !== savedCells, isSaving, hasSavedChanges, saveError, setCell, flush }
}
