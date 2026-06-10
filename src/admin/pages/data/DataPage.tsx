/**
 * DataPage — the Data workspace top-level page.
 *
 * Composes the DataSidebar, DataCanvas, and DataInspector through
 * AdminWorkspaceCanvasLayout. Capability resolution mirrors ContentPage.
 */
import { useEffect, useState } from 'react'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useNavigate } from '@admin/lib/routing'
import { useEditorStore } from '@site/store/store'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { CMS_SITE_BUNDLE_IMPORTED_EVENT } from '@admin/state/adminEvents'
import { useAdminUi } from '@admin/state/adminUi'
import {
  canCreateContent,
  canEditAnyContent,
  canManageDataTables,
} from '@admin/access'
import type { DataRow, DataRowCells, DataRowStatus } from '@core/data/schemas'
import { useDataWorkspace } from './hooks/useDataWorkspace'
import { DataSidebar } from './components/DataSidebar/DataSidebar'
import { DataCanvas } from './components/DataCanvas/DataCanvas'
import { DataInspector } from './components/DataInspector/DataInspector'
import { NewTableDialog } from './components/NewTableDialog/NewTableDialog'
import { ExportDialog } from './components/ExportDialog/ExportDialog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExportDialogOpenState {
  kind: 'open'
  initialScope: 'all' | 'selected'
  selectedRowIds: string[]
  activeTableId: string | null
}

type ExportDialogState = { kind: 'closed' } | ExportDialogOpenState

// ---------------------------------------------------------------------------
// DataPage
// ---------------------------------------------------------------------------

export function DataPage() {
  const navigate = useNavigate()
  // Strict accessor — DataPage only renders inside `AuthenticatedAdmin`,
  // which gates the entire tree on a non-null session user. A null here
  // means the page rendered outside an `AdminSessionProvider`, which is a
  // programming error, not a permission state — fail loud, don't fail
  // open. (The previous code path silently treated null as an unrestricted
  // sentinel, which masked tests that forgot to wire the provider and
  // briefly painted full-admin UI in any session-rehydration race.)
  const permissionUser = useAuthenticatedAdminUser()

  const canEdit = canEditAnyContent(permissionUser)
  const canCreate = canCreateContent(permissionUser)
  const canManage = canManageDataTables(permissionUser)
  const canDelete = canManage

  const workspace = useDataWorkspace()
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)
  const openSiteImport = useAdminUi((s) => s.openSiteImport)
  const confirmDelete = useConfirmDelete()
  const { runStepUp } = useStepUp()

  const [newTableDialogOpen, setNewTableDialogOpen] = useState(false)
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({ kind: 'closed' })

  useEffect(() => {
    function refreshAfterBundleImport() {
      void Promise.all([workspace.refreshTables(), workspace.refreshRows()])
        .catch((err) => {
          console.error('[DataPage] Refresh after import failed:', err)
        })
    }

    window.addEventListener(CMS_SITE_BUNDLE_IMPORTED_EVENT, refreshAfterBundleImport)
    return () => {
      window.removeEventListener(CMS_SITE_BUNDLE_IMPORTED_EVENT, refreshAfterBundleImport)
    }
  }, [workspace])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleEditInContent(row: DataRow) {
    const table = workspace.selectedTable
    if (!table) return
    navigate('/admin/content?table=' + table.slug + '&row=' + row.id)
  }

  function handleOpenInSiteEditor(row: DataRow) {
    const table = workspace.selectedTable
    if (!table) return
    navigate('/admin/site?table=' + table.slug + '&row=' + row.id)
  }

  async function handleAddRow(): Promise<void> {
    try {
      const newRow = await workspace.createRow()
      workspace.selectRow(newRow.id)
    } catch (err) {
      console.error('[DataPage] Add row failed:', err)
    }
  }

  async function handleDuplicateRow(row: DataRow): Promise<void> {
    try {
      await workspace.duplicateRow(row)
    } catch (err) {
      console.error('[DataPage] Duplicate row failed:', err)
    }
  }

  async function handleSaveRow(rowId: string, cells: DataRowCells) {
    return workspace.saveRow(rowId, cells)
  }

  function handleDeleteRow(rowId: string): void {
    const table = workspace.selectedTable
    const row = workspace.rows.find((r) => r.id === rowId)
    const primaryValue = row && table
      ? (typeof row.cells[table.primaryFieldId] === 'string'
          ? (row.cells[table.primaryFieldId] as string)
          : null)
      : null
    const label = primaryValue || 'row'

    confirmDelete({
      title: `Delete "${label}"?`,
      commit: () => {
        workspace.deleteRow(rowId).catch((err) => {
          console.error('[DataPage] Delete row failed:', err)
        })
      },
    })
  }

  function handleSelectRow(rowId: string | null) {
    workspace.selectRow(rowId)
    if (rowId !== null) {
      setPropertiesPanel({ collapsed: false })
    }
  }

  function handleOpenRow(rowId: string) {
    workspace.selectRow(rowId)
    setPropertiesPanel({ collapsed: false })
  }

  function handleOpenTableSettings(tableId: string) {
    workspace.selectTable(tableId)
    setPropertiesPanel({ collapsed: false })
  }

  function handleDeleteTable(tableId: string): void {
    const table = workspace.tables.find((t) => t.id === tableId)
    if (!table) return

    confirmDelete({
      title: `Delete table "${table.pluralLabel}"?`,
      description: table.rowCount > 0
        ? `This table still has ${table.rowCount} row${table.rowCount === 1 ? '' : 's'}. Delete the rows first.`
        : 'This cannot be undone.',
      confirmLabel: 'Delete table',
      commit: () => {
        runStepUp(() => workspace.deleteTable(tableId)).catch((err) => {
          if (err instanceof Error && err.message === StepUpCancelledMessage) return
          console.error('[DataPage] Delete table failed:', err)
        })
      },
    })
  }

  /**
   * Unified status setter for the DataGrid bulk-action bar. The workspace
   * exposes two endpoints — `publishRow` (transitions to 'published') and
   * `setRowStatus` (transitions to 'draft' | 'unpublished') — because the
   * server has separate routes for them. The grid only knows DataRowStatus,
   * so we dispatch here.
   *
   * `'scheduled'` is NOT reachable through this bulk-status setter — it
   * goes through the dedicated schedule dialog (`SchedulePublishDialog`,
   * which talks to the `/schedule` endpoint with a target datetime).
   * The grid's bulk-action menu doesn't expose 'scheduled' as an
   * option, so this branch is defensive: a future caller can't slip a
   * 'scheduled' value through without first picking a time.
   */
  async function handleSetRowStatus(rowId: string, status: DataRowStatus): Promise<DataRow> {
    if (status === 'published') return workspace.publishRow(rowId)
    if (status === 'scheduled') {
      throw new Error('Scheduling requires a target datetime — use the schedule dialog instead')
    }
    return workspace.setRowStatus(rowId, status)
  }

  const selectedTable = workspace.selectedTable

  // ---------------------------------------------------------------------------
  // Right panel (inspector)
  // ---------------------------------------------------------------------------

  const rightPanel = selectedTable ? (
    <DataInspector
      table={selectedTable}
      tables={workspace.tables}
      row={workspace.selectedRow}
      rows={workspace.rows}
      onSaveRow={handleSaveRow}
      onUpdateTable={async (input) => {
        return runStepUp(() => workspace.updateTable(selectedTable.id, input))
      }}
      onDeleteTable={async () => {
        await runStepUp(() => workspace.deleteTable(selectedTable.id))
      }}
      onEditInContent={handleEditInContent}
      onOpenInSiteEditor={handleOpenInSiteEditor}
      onPublishRow={async (rowId) => workspace.publishRow(rowId)}
      onSetRowStatus={async (rowId, status) => workspace.setRowStatus(rowId, status)}
      canEdit={canEdit}
      canDelete={canDelete}
    />
  ) : undefined

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <AdminWorkspaceCanvasLayout
        workspace="data"
        contentSidebar={(
          <DataSidebar
            tables={workspace.tables}
            loading={workspace.loadingTables}
            error={workspace.tablesError}
            selectedTableId={workspace.selectedTableId}
            onSelectTable={workspace.selectTable}
            onOpenTableSettings={handleOpenTableSettings}
            onDeleteTable={(table) => handleDeleteTable(table.id)}
            onCreateTable={() => setNewTableDialogOpen(true)}
            onOpenExport={() => setExportDialog({
              kind: 'open',
              initialScope: 'all',
              selectedRowIds: [],
              activeTableId: workspace.selectedTableId,
            })}
            onOpenImport={openSiteImport}
            canCreate={canCreate}
            canManage={canManage}
          />
        )}
        contentCanvas={(
          <DataCanvas
            table={selectedTable}
            tables={workspace.tables}
            rows={workspace.rows}
            loading={workspace.loadingRows}
            loadingTables={workspace.loadingTables}
            error={workspace.rowsError}
            selectedRowId={workspace.selectedRowId}
            onSelectRow={handleSelectRow}
            onAddRow={handleAddRow}
            onDeleteRow={handleDeleteRow}
            onDuplicateRow={handleDuplicateRow}
            onEditInContent={handleEditInContent}
            onOpenInSiteEditor={handleOpenInSiteEditor}
            onOpenRow={handleOpenRow}
            onSetRowStatus={handleSetRowStatus}
            onExportRows={(rowIds) => setExportDialog({
              kind: 'open',
              initialScope: 'selected',
              selectedRowIds: rowIds,
              activeTableId: workspace.selectedTableId,
            })}
            canCreate={canCreate}
            canEdit={canEdit}
            canDelete={canDelete}
          />
        )}
        contentRightPanel={rightPanel}
      />

      {newTableDialogOpen && (
        <NewTableDialog
          open={newTableDialogOpen}
          onClose={() => setNewTableDialogOpen(false)}
          onCreate={async (input) => {
            await runStepUp(() => workspace.createTable(input))
            setNewTableDialogOpen(false)
          }}
        />
      )}

      {exportDialog.kind === 'open' && (
        <ExportDialog
          open={true}
          onClose={() => setExportDialog({ kind: 'closed' })}
          tables={workspace.tables}
          activeTableId={exportDialog.activeTableId}
          selectedRowIds={exportDialog.selectedRowIds}
          initialScope={exportDialog.initialScope}
        />
      )}

    </>
  )
}
