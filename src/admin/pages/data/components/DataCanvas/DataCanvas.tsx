/**
 * DataCanvas — the central canvas region for the Data workspace.
 *
 * Either shows an empty-state placeholder when no table is selected,
 * or renders the DataGrid for the active table.
 *
 * For tables with a publish workflow (`postType`, `page`, `component`) the
 * DataGrid itself renders a chip-style status filter and groups rows by
 * status — see `DataGrid.tsx`. There is no canvas-level filter bar; the
 * grid owns its own toolbar so the visual language stays consistent across
 * all three kinds.
 */
import { DatabaseSolidIcon } from 'pixel-art-icons/icons/database-solid'
import { EmptyState } from '@ui/components/EmptyState'
import { DataGrid } from '../DataGrid/DataGrid'
import { DataGridSkeleton } from '../DataGrid/DataGridSkeleton'
import type { DataRow, DataRowStatus, DataTable } from '@core/data/schemas'
// Reuse the site canvas surface token so the Data page matches
// Site / Content / Media visual language.
import canvasStyles from '@site/canvas/CanvasRoot.module.css'
import styles from './DataCanvas.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DataCanvasProps {
  table: DataTable | null
  tables: DataTable[]
  rows: DataRow[]
  loading: boolean
  /**
   * `true` while the table list itself is still loading. Shown as a
   * full-canvas `DataGridSkeleton` so the user never sees the "Select
   * a table" empty state during the first paint — that placeholder
   * only fires after the table list arrives empty (no tables exist).
   *
   * Once a first table is auto-selected by the workspace, this turns
   * `false` and the real `DataGrid` takes over with its own
   * row-loading skeleton — visually identical chrome, so the swap
   * reads as one continuous loading state.
   */
  loadingTables: boolean
  error: string | null
  selectedRowId: string | null
  onSelectRow: (rowId: string | null) => void
  onAddRow: () => Promise<void>
  onDeleteRow: (rowId: string) => void
  onDuplicateRow: (row: DataRow) => void | Promise<void>
  onEditInContent: (row: DataRow) => void
  onOpenInSiteEditor: (row: DataRow) => void
  onOpenRow: (rowId: string) => void
  /** Set a row's status — powers the grid's bulk publish / draft actions. */
  onSetRowStatus: (rowId: string, status: DataRowStatus) => Promise<DataRow>
  /** Opens the ExportDialog pre-filled with the selected row ids. */
  onExportRows?: (rowIds: string[]) => void
  canCreate: boolean
  canEdit: boolean
  canDelete: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataCanvas({
  table,
  tables,
  rows,
  loading,
  loadingTables,
  error,
  selectedRowId,
  onSelectRow,
  onAddRow,
  onDeleteRow,
  onDuplicateRow,
  onEditInContent,
  onOpenInSiteEditor,
  onOpenRow,
  onSetRowStatus,
  onExportRows,
  canCreate,
  canEdit,
  canDelete,
}: DataCanvasProps) {
  // Tables still loading — render the layout skeleton (toolbar + chip
  // filter + grid placeholder) instead of the "Select a table" empty
  // state. The workspace auto-selects the first table as soon as the
  // list arrives, so the empty state only ever shows when the install
  // genuinely has no tables.
  if (!table && loadingTables) {
    return (
      <section className={`${canvasStyles.canvas} ${styles.canvas}`} aria-label="Loading data tables">
        <DataGridSkeleton />
      </section>
    )
  }

  if (!table) {
    return (
      <section className={`${canvasStyles.canvas} ${styles.canvasEmpty}`} aria-label="Data canvas">
        <EmptyState
          variant="centered"
          icon={<DatabaseSolidIcon size={20} aria-hidden="true" />}
          title="Select a table"
          description="Choose a data table from the sidebar to view and edit its rows."
        />
      </section>
    )
  }

  return (
    <section className={`${canvasStyles.canvas} ${styles.canvas}`} aria-label={`${table.pluralLabel} data grid`}>
      <DataGrid
        table={table}
        rows={rows}
        tables={tables}
        selectedRowId={selectedRowId}
        loading={loading}
        error={error}
        readOnly={!canEdit}
        onSelectRow={onSelectRow}
        onAddRow={onAddRow}
        onEditInContent={onEditInContent}
        onDuplicateRow={canCreate ? onDuplicateRow : undefined}
        onOpenInSiteEditor={onOpenInSiteEditor}
        onOpenRow={onOpenRow}
        onDeleteRow={canDelete ? onDeleteRow : undefined}
        onSetRowStatus={canEdit ? onSetRowStatus : undefined}
        onExportRows={canEdit ? onExportRows : undefined}
      />
    </section>
  )
}
