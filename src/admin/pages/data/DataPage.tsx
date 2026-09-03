/**
 * DataPage — the Data workspace top-level page.
 *
 * Composes the DataSidebar, DataCanvas, and DataInspector through
 * AdminWorkspaceCanvasLayout. Capability resolution mirrors ContentPage.
 */
import { useEffect, useRef, useState } from 'react'
import { AdminWorkspaceCanvasLayout } from '@admin/layouts/AdminWorkspaceCanvasLayout'
import { useAuthenticatedAdminUser } from '@admin/sessionContext'
import { useNavigate } from '@admin/lib/routing'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { CMS_SITE_BUNDLE_IMPORTED_EVENT } from '@admin/state/adminEvents'
import { useAdminUi } from '@admin/state/adminUi'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import {
  canAccessDataRows,
  canCreateContent,
  canEditAnyContent,
  canExportData,
  canImportData,
  canManageDataTables,
  canManageTable,
  canPublishContentEntry,
} from '@admin/access'
import type { DataRow, DataRowCells, DataRowStatus } from '@core/data/schemas'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { PublishActionGroup, type PublishActionMenuItem } from '@site/toolbar/PublishActionGroup'
import { useBranchPublishGate } from '@admin/state/branchStore'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import { SendSolidIcon } from 'pixel-art-icons/icons/send-solid'
import { useDataWorkspace } from './hooks/useDataWorkspace'
import { DataSidebar } from './components/DataSidebar/DataSidebar'
import { DataCanvas } from './components/DataCanvas/DataCanvas'
import { DataInspector } from './components/DataInspector/DataInspector'
import { NewTableDialog } from './components/NewTableDialog/NewTableDialog'
import type { DataRowDraftState } from './components/DataInspector/RowDetail'

function hasDraftChanges(row: DataRow): boolean {
  if (row.status === 'scheduled') return false
  if (row.status !== 'published') return true
  if (row.publishedAt === null) return true
  return new Date(row.updatedAt).getTime() > new Date(row.publishedAt).getTime()
}

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

  const canEditRows = canEditAnyContent(permissionUser)
  const canCreateRows = canCreateContent(permissionUser)
  const canManageCustomTables = canManageDataTables(permissionUser)
  const canDeleteRows = canEditRows
  const canExport = canExportData(permissionUser)
  const canImport = canImportData(permissionUser)
  const canLoadRows = canAccessDataRows(permissionUser)

  const workspace = useDataWorkspace({ shouldLoadRows: canLoadRows })
  const setRightPanel = useWorkspaceLayout((s) => s.setRightPanel)
  const openSiteImport = useAdminUi((s) => s.openSiteImport)
  const openSiteExport = useAdminUi((s) => s.openSiteExport)
  const confirmDelete = useConfirmDelete()
  const { runStepUp } = useStepUp()

  const [newTableDialogOpen, setNewTableDialogOpen] = useState(false)
  const [activeDraft, setActiveDraft] = useState<DataRowDraftState | null>(null)
  const activeDraftRef = useRef<DataRowDraftState | null>(null)
  const [publishState, setPublishState] = useState<'idle' | 'publishing' | 'published' | 'error'>('idle')

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
      pushToast({ kind: 'error', title: 'Could not add row', body: getErrorMessage(err, 'Unknown error') })
    }
  }

  async function handleDuplicateRow(row: DataRow): Promise<void> {
    try {
      await workspace.duplicateRow(row)
    } catch (err) {
      console.error('[DataPage] Duplicate row failed:', err)
      pushToast({ kind: 'error', title: 'Could not duplicate row', body: getErrorMessage(err, 'Unknown error') })
    }
  }

  async function handleSaveRow(rowId: string, cells: DataRowCells) {
    return workspace.saveRow(rowId, cells)
  }

  function handleDraftStateChange(state: DataRowDraftState | null) {
    activeDraftRef.current = state
    setActiveDraft(state)
    if (state?.isDirty) setPublishState('idle')
  }

  async function handleSaveActiveDraft(): Promise<DataRow | null> {
    const draft = activeDraftRef.current
    if (!draft || draft.isSaving) return null
    return draft.flush()
  }

  async function handlePublishData(): Promise<void> {
    if (publishState === 'publishing' || activeDraftRef.current?.isSaving) return
    setPublishState('publishing')
    try {
      const flushedRow = await handleSaveActiveDraft()
      const currentDraft = activeDraftRef.current
      if (currentDraft && !currentDraft.isSaving && !flushedRow) {
        throw new Error('The active row draft could not be saved')
      }

      const rows = flushedRow
        ? workspace.rows.map((row) => row.id === flushedRow.id ? flushedRow : row)
        : workspace.rows
      const publishableRows = rows.filter((row) =>
        hasDraftChanges(row) && canPublishContentEntry(permissionUser, row),
      )

      for (const row of publishableRows) {
        await workspace.publishRow(row.id)
      }

      setPublishState('published')
      pushToast({
        kind: 'success',
        title: 'Data published',
        body: `${publishableRows.length} row${publishableRows.length === 1 ? '' : 's'} published.`,
        location: 'data-workspace',
      })
    } catch (err) {
      console.error('[DataPage] Publish data failed:', err)
      setPublishState('error')
      pushToast({
        kind: 'error',
        title: 'Data publish failed',
        body: getErrorMessage(err, 'Could not publish data'),
        location: 'data-workspace',
      })
    }
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
      setRightPanel({ collapsed: false })
    }
  }

  function handleOpenRow(rowId: string) {
    workspace.selectRow(rowId)
    setRightPanel({ collapsed: false })
  }

  function handleOpenTableSettings(tableId: string) {
    workspace.selectTable(tableId)
    setRightPanel({ collapsed: false })
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
  const rowsWithDraftChanges = workspace.rows.filter(hasDraftChanges)
  const activeDraftDirty = activeDraft?.isDirty ?? false
  const hasPublishableChanges = activeDraftDirty || rowsWithDraftChanges.some((row) =>
    canPublishContentEntry(permissionUser, row),
  )
  const isSavingDraft = activeDraft?.isSaving ?? false
  const publishBusy = publishState === 'publishing'
  const publishMenuItems: PublishActionMenuItem[] = [{
    id: 'save-draft',
    label: 'Save draft',
    icon: SaveSolidIcon,
    disabled: !activeDraftDirty || isSavingDraft || publishBusy,
    onSelect: () => { void handleSaveActiveDraft() },
    testId: 'toolbar-data-save-draft-action',
  }]
  // Publishing only exists on main — on a branch the group stays visible but
  // disabled, with the reason inline.
  const branchGate = useBranchPublishGate()
  const publishStatus = activeDraft?.saveError
    ? { label: 'Draft save failed', tone: 'danger' as const }
    : isSavingDraft
      ? { label: 'Saving draft', tone: 'neutral' as const }
      : hasPublishableChanges
        ? { label: activeDraftDirty ? 'Unsaved draft' : 'Draft changes', tone: 'warning' as const }
        : { label: 'Published', tone: 'success' as const }
  const PublishDataIcon = publishBusy
    ? LoaderIcon
    : publishState === 'error'
      ? CircleAlertSolidIcon
      : !hasPublishableChanges
        ? CheckIcon
        : SendSolidIcon

  // ---------------------------------------------------------------------------
  // Right panel (inspector)
  // ---------------------------------------------------------------------------

  // Schema management is kind-aware: custom tables need `data.custom.tables.manage`,
  // system tables need `data.system.tables.manage`. Deletion is never allowed on
  // a system table (the server blocks it; the UI hides the affordance).
  const canManageSchema = selectedTable ? canManageTable(permissionUser, selectedTable) : canManageCustomTables
  const canDeleteTable = Boolean(selectedTable) && canManageSchema && !selectedTable?.system

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
      canEdit={canEditRows}
      canManageSchema={canManageSchema}
      canDelete={canDeleteTable}
      onDraftStateChange={handleDraftStateChange}
    />
  ) : undefined

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <AdminWorkspaceCanvasLayout
        workspace="data"
        toolbarRightSlot={selectedTable ? (
          <PublishActionGroup
            statusLabel={publishStatus.label}
            statusTone={publishStatus.tone}
            statusAriaLabel={branchGate.reason ?? undefined}
            publishLabel={publishBusy ? 'Publishing' : !hasPublishableChanges && !branchGate.onBranch ? 'Published' : 'Publish data'}
            publishAriaLabel={
              branchGate.reason
                ? `Cannot publish: ${branchGate.reason}`
                : !hasPublishableChanges ? 'Data published' : 'Publish data'
            }
            publishTitle={
              branchGate.reason
                ?? (!hasPublishableChanges ? 'Data published' : `Publish changes to ${selectedTable.pluralLabel}`)
            }
            publishState={publishBusy ? 'busy' : publishState === 'error' ? 'error' : !hasPublishableChanges && !branchGate.onBranch ? 'success' : 'idle'}
            publishBusy={publishBusy}
            publishDisabled={branchGate.onBranch || !hasPublishableChanges || activeDraftDirty || isSavingDraft || publishBusy}
            publishIcon={PublishDataIcon}
            onPublish={handlePublishData}
            menuItems={publishMenuItems}
            menuLabel="Data publishing actions"
            triggerLabel="More data publishing actions"
          />
        ) : null}
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
            onOpenExport={() => openSiteExport({
              activeTableId: workspace.selectedTableId,
              initialScope: 'all',
            })}
            onOpenImport={openSiteImport}
            canCreateTable={canManageCustomTables}
            canManage={canManageCustomTables}
            canExport={canExport}
            canImport={canImport}
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
            onExportRows={(rowIds) => openSiteExport({
              activeTableId: workspace.selectedTableId,
              selectedRowIds: rowIds,
              initialScope: 'selected',
            })}
            canCreate={canCreateRows}
            canEdit={canEditRows}
            canDelete={canDeleteRows}
            canExport={canExport}
          />
        )}
        contentRightPanel={rightPanel}
      />

      {newTableDialogOpen && (
        <NewTableDialog
          open={newTableDialogOpen}
          onClose={() => setNewTableDialogOpen(false)}
          tables={workspace.tables}
          onCreate={async (input) => {
            await runStepUp(() => workspace.createTable(input))
            setNewTableDialogOpen(false)
          }}
        />
      )}

    </>
  )
}
