import { useEffect, useRef, useState } from 'react'
import { useInitialQueryParams, useUrlQuerySync } from '@admin/lib/urlState'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import {
  createCmsDataRow,
  createCmsDataTable,
  deleteCmsDataRow,
  deleteCmsDataTable,
  listCmsDataRows,
  listCmsDataTables,
  publishCmsDataRow,
  saveCmsDataRowDraft,
  updateCmsDataTable,
  updateCmsDataRowStatus,
} from '@core/persistence'
import type {
  DataTable,
  DataTableListItem,
  DataRow,
  DataRowCells,
  CreateDataTableInput,
  UpdateDataTableInput,
} from '@core/data/schemas'
import { buildDuplicateRowCells } from '@core/data/duplicateRow'
import { buildEmptyCells } from '../utils/fieldDefaults'
import { getErrorMessage } from '@core/utils/errorMessage'

function updateRowList(rows: DataRow[], row: DataRow): DataRow[] {
  const idx = rows.findIndex((r) => r.id === row.id)
  if (idx === -1) return [row, ...rows]
  const next = [...rows]
  next[idx] = row
  return next
}

function tableBacksSiteDocument(table: DataTableListItem | null): boolean {
  return table?.kind === 'page' || table?.kind === 'component'
}

/**
 * Intentional exception to WorkspaceLoadState: this hook runs two independent
 * fetches (tables + rows) that load at different times, so the granular
 * loadingTables/loadingRows and tablesError/rowsError fields are kept instead
 * of a single composite loading/error pair.
 */
interface DataWorkspace {
  tables: DataTableListItem[]
  loadingTables: boolean
  tablesError: string | null
  selectedTableId: string | null
  selectedTable: DataTableListItem | null
  selectTable: (tableId: string | null) => void
  refreshTables: () => Promise<void>
  createTable: (input: CreateDataTableInput) => Promise<DataTable>
  updateTable: (tableId: string, input: UpdateDataTableInput) => Promise<DataTable>
  deleteTable: (tableId: string) => Promise<void>
  rows: DataRow[]
  loadingRows: boolean
  rowsError: string | null
  refreshRows: () => Promise<void>
  createRow: (cells?: DataRowCells) => Promise<DataRow>
  duplicateRow: (row: DataRow) => Promise<DataRow>
  saveRow: (rowId: string, cells: DataRowCells) => Promise<DataRow>
  deleteRow: (rowId: string) => Promise<void>
  selectedRowId: string | null
  selectedRow: DataRow | null
  selectRow: (rowId: string | null) => void
  publishRow: (rowId: string) => Promise<DataRow>
  setRowStatus: (rowId: string, status: 'draft' | 'unpublished') => Promise<DataRow>
}

interface DataWorkspaceOptions {
  shouldLoadRows: boolean
}

export function useDataWorkspace({ shouldLoadRows }: DataWorkspaceOptions): DataWorkspace {
  // The Data workspace is directly linkable via `?table=<slug>&row=<id>`. We
  // capture the params at mount once (so the URL sync below can't clobber the
  // one-shot read) and mirror the live selection back into the URL.
  const initialParams = useInitialQueryParams()
  const initialTableSlug = initialParams.get('table') ?? undefined
  // Holds the deep-linked row id until the initial table's rows have loaded;
  // cleared after the one-shot apply.
  const initialRowIdRef = useRef<string | null>(initialParams.get('row'))

  const [tables, setTables] = useState<DataTableListItem[]>([])
  // Initialize to true — the on-mount effect starts a fetch immediately, so
  // the loading state is already correct with no synchronous setState needed.
  const [loadingTables, setLoadingTables] = useState(true)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)

  // Render-time reset for rows when the selected table changes — avoids
  // setState-in-effect.  loadingRows is pre-set to true when a table is
  // selected (a fetch is about to start) or false when no table is selected.
  const [trackedTableId, setTrackedTableId] = useState<string | null>(null)
  const [rows, setRows] = useState<DataRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [rowsError, setRowsError] = useState<string | null>(null)
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const [trackedLoadRows, setTrackedLoadRows] = useState(shouldLoadRows)

  if (trackedTableId !== selectedTableId || trackedLoadRows !== shouldLoadRows) {
    setTrackedTableId(selectedTableId)
    setTrackedLoadRows(shouldLoadRows)
    setRows([])
    setRowsError(null)
    setLoadingRows(selectedTableId !== null && shouldLoadRows)
  }

  const selectedTable = tables.find((t) => t.id === selectedTableId) ?? null
  const selectedRow = rows.find((r) => r.id === selectedRowId) ?? null

  // ---------------------------------------------------------------------------
  // Load tables on mount
  // ---------------------------------------------------------------------------
  // Effects must not call named functions that contain setState — the lint rule
  // (react-hooks/set-state-in-effect) performs interprocedural analysis and
  // flags those call sites.  Use an inline async IIFE so the rule can verify
  // that all setState calls happen after the first `await`.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const dataTables = await listCmsDataTables()
        if (cancelled) return
        setTables(dataTables)
        setTablesError(null)
        setSelectedTableId((current) => {
          if (current) return current
          if (initialTableSlug) {
            const bySlug = dataTables.find((t) => t.slug === initialTableSlug)
            return bySlug?.id ?? dataTables[0]?.id ?? null
          }
          return dataTables[0]?.id ?? null
        })
      } catch (err) {
        if (!cancelled) {
          console.error('[data-workspace] Failed to load tables:', err)
          setTablesError(getErrorMessage(err, 'Could not load tables'))
        }
      } finally {
        if (!cancelled) setLoadingTables(false)
      }
    })()
    return () => { cancelled = true }
  }, [initialTableSlug])

  // ---------------------------------------------------------------------------
  // Load rows when selected table changes
  // ---------------------------------------------------------------------------
  // Same rationale as the tables effect — inline IIFE keeps all setState after
  // the first await and out of the interprocedural analysis path.
  useEffect(() => {
    if (!selectedTableId || !shouldLoadRows) return
    let cancelled = false
    void (async () => {
      try {
        const nextRows = await listCmsDataRows(selectedTableId)
        if (cancelled) return
        setRows(nextRows)
        setRowsError(null)
      } catch (err) {
        if (!cancelled) {
          console.error('[data-workspace] Failed to load rows:', err)
          setRowsError(getErrorMessage(err, 'Could not load rows'))
        }
      } finally {
        if (!cancelled) setLoadingRows(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedTableId, shouldLoadRows])

  // Deep-link: once the (initially selected) table's rows have loaded, select
  // the `?row=<id>` from the URL. One-shot — cleared after the first apply so
  // later selections / reloads don't re-trigger it.
  useEffect(() => {
    const rowId = initialRowIdRef.current
    if (!rowId) return
    if (!shouldLoadRows) return
    if (selectedTableId === null || loadingRows || trackedTableId !== selectedTableId) return

    initialRowIdRef.current = null
    if (rows.some((r) => r.id === rowId)) {
      setSelectedRowId(rowId)
    } else {
      console.warn('[data-workspace] unknown ?row= id:', rowId)
    }
  }, [rows, loadingRows, selectedTableId, trackedTableId, shouldLoadRows])

  // Mirror the active table + row into the URL so the view is directly
  // linkable. Contract matches the inbound deep link: `?table=<slug>&row=<id>`.
  // Gated on `!loadingTables` so the initial selection settles before we write
  // (otherwise the first render would briefly strip an inbound deep link).
  useUrlQuerySync(
    { table: selectedTable?.slug ?? null, row: selectedRowId },
    { enabled: !loadingTables },
  )

  // ---------------------------------------------------------------------------
  // Table actions
  // ---------------------------------------------------------------------------
  //
  // Row state (rows / rowsError / loadingRows) is reset by the render-time
  // `trackedTableId !== selectedTableId` block above whenever the selection
  // actually changes — we MUST NOT pre-clear rows here, otherwise re-clicking
  // the already-selected table (selectedTableId stays the same) would wipe
  // rows without re-running the load-rows effect, leaving an empty grid that
  // only recovers when the user navigates away and back.
  const selectTable = (tableId: string | null) => {
    setSelectedTableId(tableId)
    setSelectedRowId(null)
  }

  // loadTables / loadRows are only called from event-handler callbacks
  // (refreshTables / refreshRows), never from effects, so setState calls
  // before the first await are fine here.
  const loadTables = async () => {
    try {
      const dataTables = await listCmsDataTables()
      setTables(dataTables)
      setTablesError(null)
      setSelectedTableId((current) => {
        if (current) return current
        if (initialTableSlug) {
          const bySlug = dataTables.find((t) => t.slug === initialTableSlug)
          return bySlug?.id ?? dataTables[0]?.id ?? null
        }
        return dataTables[0]?.id ?? null
      })
    } catch (err) {
      console.error('[data-workspace] Failed to load tables:', err)
      setTablesError(getErrorMessage(err, 'Could not load tables'))
    } finally {
      setLoadingTables(false)
    }
  }

  // Called from event handlers — synchronous setState before await is fine.
  const refreshTables = async () => {
    setLoadingTables(true)
    setTablesError(null)
    await loadTables()
  }

  const createTable = async (input: CreateDataTableInput): Promise<DataTable> => {
    setTablesError(null)
    const table = await createCmsDataTable(input)
    // Newly created table has no rows yet.
    setTables((current) => [...current, { ...table, rowCount: 0 }])
    setSelectedTableId(table.id)
    setRows([])
    setSelectedRowId(null)
    return table
  }

  const updateTable = async (
    tableId: string,
    input: UpdateDataTableInput,
  ): Promise<DataTable> => {
    setTablesError(null)
    const table = await updateCmsDataTable(tableId, input)
    // Preserve the existing rowCount — the update endpoint returns a plain
    // DataTable (no rowCount), so we carry it forward from the current entry.
    setTables((current) => current.map((t) =>
      t.id === tableId ? { ...table, rowCount: t.rowCount } : t,
    ))
    return table
  }

  const deleteTable = async (tableId: string): Promise<void> => {
    setTablesError(null)
    await deleteCmsDataTable(tableId)
    setTables((current) => current.filter((t) => t.id !== tableId))
    setSelectedTableId((cur) => {
      if (cur !== tableId) return cur
      // Select the next available table after deletion; will be re-derived
      // once setTables settles, so passing null here is safe.
      return null
    })
    setRows([])
    setSelectedRowId(null)
  }

  // ---------------------------------------------------------------------------
  // Row actions
  // ---------------------------------------------------------------------------
  const loadRows = async (tableId: string) => {
    try {
      const nextRows = await listCmsDataRows(tableId)
      setRows(nextRows)
      setRowsError(null)
    } catch (err) {
      console.error('[data-workspace] Failed to load rows:', err)
      setRowsError(getErrorMessage(err, 'Could not load rows'))
    } finally {
      setLoadingRows(false)
    }
  }

  // Called from event handlers — synchronous setState before await is fine.
  const refreshRows = async (): Promise<void> => {
    if (!selectedTableId || !shouldLoadRows) return
    setLoadingRows(true)
    setRowsError(null)
    await loadRows(selectedTableId)
  }

  const createRow = async (cells?: DataRowCells): Promise<DataRow> => {
    if (!selectedTable) throw new Error('No table selected')
    setRowsError(null)
    const payload = cells ?? buildEmptyCells(selectedTable.fields)
    const row = await createCmsDataRow(selectedTable.id, { cells: payload })
    setRows((current) => updateRowList(current, row))
    if (tableBacksSiteDocument(selectedTable)) requestCmsSiteReload()
    return row
  }

  const duplicateRow = async (sourceRow: DataRow): Promise<DataRow> => {
    if (!selectedTable) throw new Error('No table selected')
    if (sourceRow.tableId !== selectedTable.id) throw new Error('Row is not in the selected table')
    setRowsError(null)
    const row = await createCmsDataRow(sourceRow.tableId, {
      cells: buildDuplicateRowCells(selectedTable, sourceRow, rows),
    })
    setRows((current) => updateRowList(current, row))
    setSelectedRowId(row.id)
    if (tableBacksSiteDocument(selectedTable)) requestCmsSiteReload()
    return row
  }

  const saveRow = async (rowId: string, cells: DataRowCells): Promise<DataRow> => {
    setRowsError(null)
    const row = await saveCmsDataRowDraft(rowId, { cells })
    setRows((current) => updateRowList(current, row))
    if (tableBacksSiteDocument(selectedTable)) requestCmsSiteReload()
    return row
  }

  const deleteRow = async (rowId: string): Promise<void> => {
    setRowsError(null)
    await deleteCmsDataRow(rowId)
    setRows((current) => current.filter((r) => r.id !== rowId))
    setSelectedRowId((cur) => (cur === rowId ? null : cur))
    if (tableBacksSiteDocument(selectedTable)) requestCmsSiteReload()
  }

  const selectRow = (rowId: string | null) => {
    setSelectedRowId(rowId)
  }

  const publishRow = async (rowId: string): Promise<DataRow> => {
    setRowsError(null)
    const row = await publishCmsDataRow(rowId)
    setRows((current) => updateRowList(current, row))
    return row
  }

  const setRowStatus = async (
    rowId: string,
    status: 'draft' | 'unpublished',
  ): Promise<DataRow> => {
    setRowsError(null)
    const row = await updateCmsDataRowStatus(rowId, status)
    setRows((current) => updateRowList(current, row))
    return row
  }

  return {
    tables,
    loadingTables,
    tablesError,
    selectedTableId,
    selectedTable,
    selectTable,
    refreshTables,
    createTable,
    updateTable,
    deleteTable,
    rows,
    loadingRows,
    rowsError,
    refreshRows,
    createRow,
    duplicateRow,
    saveRow,
    deleteRow,
    selectedRowId,
    selectedRow,
    selectRow,
    publishRow,
    setRowStatus,
  }
}
