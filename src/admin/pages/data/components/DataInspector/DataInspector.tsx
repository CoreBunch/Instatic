import type { ReactElement } from 'react'
import type { DataTable, DataRow, DataRowCells, UpdateDataTableInput } from '@core/data/schemas'
import type { PageAccess } from '@core/page-tree'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { useWorkspaceLayout } from '@admin/state/workspaceLayout'
import { cn } from '@ui/cn'
import propertiesStyles from '@admin/pages/site/panels/PropertiesPanel/PropertiesPanel.module.css'
import styles from './DataInspector.module.css'
import { RowDetail } from './RowDetail'
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
  /** Persist a page's access (Public / group-restricted) — pages write via site-document, not the data grid. */
  onSavePageAccess: (row: DataRow, access: PageAccess) => Promise<void>
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DataInspector({
  table,
  tables,
  row,
  rows,
  onSaveRow,
  onSavePageAccess,
  onUpdateTable,
  onDeleteTable,
  onEditInContent,
  onOpenInSiteEditor,
  onPublishRow,
  onSetRowStatus,
  canEdit,
  canManageSchema,
  canDelete,
}: DataInspectorProps): ReactElement {
  const setRightPanel = useWorkspaceLayout((s) => s.setRightPanel)

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
      role="complementary"
      aria-label={`Data ${resolvedTitle}`}
      className={cn(propertiesStyles.panel, propertiesStyles.panelDocked)}
    >
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

      <div className={styles.body}>
        {row !== null ? (
          <RowDetail
            row={row}
            table={table}
            tables={tables}
            onSaveRow={onSaveRow}
            onSavePageAccess={onSavePageAccess}
            onEditInContent={onEditInContent}
            onOpenInSiteEditor={onOpenInSiteEditor}
            onPublishRow={onPublishRow}
            onSetRowStatus={onSetRowStatus}
            resolveRow={resolveRow}
            canEdit={canEdit}
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
