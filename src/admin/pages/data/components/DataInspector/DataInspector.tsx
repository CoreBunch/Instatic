import type { ReactElement } from 'react'
import type { DataTable, DataRow, DataRowCells, UpdateDataTableInput } from '@core/data/schemas'
import { useMobileViewport } from '@admin/lib/mobileViewport'
import { Button } from '@ui/components/Button'
import { ArrowLeftIcon } from 'pixel-art-icons/icons/arrow-left'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { cn } from '@ui/cn'
import propertiesStyles from '@admin/pages/site/panels/PropertiesPanel/PropertiesPanel.module.css'
import styles from './DataInspector.module.css'
import { RowDetail } from './RowDetail'
import type { DataRowDraftState } from './RowDetail'
import { TableSettings } from './TableSettings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DataInspectorProps {
  table: DataTable
  /** All tables — used for relation target lookups. */
  tables: DataTable[]
  /** Currently selected row (null = no selection → shows TableSettings). */
  row: DataRow | null
  /** All rows of the current table. */
  rows: DataRow[]
  onSaveRow: (rowId: string, cells: DataRowCells) => Promise<DataRow>
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>
  onDeleteTable: () => Promise<void>
  /** Navigate the Content page to edit this post-type row. */
  onEditInContent?: (row: DataRow) => void
  /** Navigate the Site editor to open this page or component row. */
  onOpenInSiteEditor?: (row: DataRow) => void
  onPublishRow?: (rowId: string) => Promise<DataRow>
  onSetRowStatus?: (rowId: string, status: 'draft' | 'unpublished') => Promise<DataRow>
  /** Row-level content editing (RowDetail cell editors). */
  canEdit: boolean
  /** Schema editing in Table settings — kind-aware (custom vs system manage). */
  canManageSchema: boolean
  canDelete: boolean
  activeDraft: DataRowDraftState | null
  onDraftStateChange?: (state: DataRowDraftState | null) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function draftStatusLabel(draft: DataRowDraftState | null): string {
  if (draft?.saveError) return 'Could not save draft'
  if (draft?.isSaving) return 'Saving draft…'
  if (draft?.isDirty) return 'Unsaved changes'
  return draft?.hasSavedChanges ? 'Draft saved' : ''
}

export function DataInspector({
  table,
  tables,
  row,
  rows,
  onSaveRow,
  onUpdateTable,
  onDeleteTable,
  onEditInContent,
  onOpenInSiteEditor,
  onPublishRow,
  onSetRowStatus,
  canEdit,
  canManageSchema,
  canDelete,
  activeDraft,
  onDraftStateChange,
}: DataInspectorProps): ReactElement {
  const setRightPanel = useWorkspaceLayout((s) => s.setRightPanel)

  const mobileRow = useMobileViewport() && row !== null

  async function backToRows() {
    if (activeDraft) {
      const saved = await activeDraft.flush()
      if (!saved) return
    }
    setRightPanel({ collapsed: true })
  }

  function resolveRow(rowId: string): DataRow | null {
    return rows.find((r) => r.id === rowId) ?? null
  }

  const resolvedTitle = row !== null
    ? (table.singularLabel || 'Row')
    : 'Table settings'

  return (
    <aside
      data-panel=""
      data-testid="data-inspector-panel"
      aria-label={`Data ${resolvedTitle}`}
      className={cn(propertiesStyles.panel, propertiesStyles.panelDocked)}
    >
      {mobileRow ? (
        <div className={styles.rowNavigation}>
          <Button variant="ghost" size="lg" onClick={() => void backToRows()}>
            <ArrowLeftIcon size={14} aria-hidden="true" />
            Back to rows
          </Button>
          <output className={styles.draftStatus}>
            {draftStatusLabel(activeDraft)}
          </output>
        </div>
      ) : (
        <PanelHeader
          panelId="data-inspector"
          title={resolvedTitle}
          titleContent={(
            <span className={propertiesStyles.headerNodeTitle}>
              <Settings2SolidIcon size={13} aria-hidden="true" />
              <span className={propertiesStyles.headerNodeLabel}>{resolvedTitle}</span>
            </span>
          )}
          onClose={() => setRightPanel({ collapsed: true })}
        />
      )}

      <div className={styles.body}>
        {row !== null ? (
          <RowDetail
            key={row.id}
            mobile={mobileRow}
            row={row}
            table={table}
            tables={tables}
            onSaveRow={onSaveRow}
            onEditInContent={onEditInContent}
            onOpenInSiteEditor={onOpenInSiteEditor}
            onPublishRow={onPublishRow}
            onSetRowStatus={onSetRowStatus}
            resolveRow={resolveRow}
            canEdit={canEdit}
            onDraftStateChange={onDraftStateChange}
          />
        ) : (
          <TableSettings
            table={table}
            tables={tables}
            rows={rows}
            onUpdateTable={onUpdateTable}
            onDeleteTable={onDeleteTable}
            canEdit={canManageSchema}
            canDelete={canDelete}
          />
        )}
      </div>
    </aside>
  )
}
