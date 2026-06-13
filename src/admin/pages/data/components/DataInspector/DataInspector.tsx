import type { ReactElement } from 'react'
import type { DataTable, DataRow, DataRowCells, UpdateDataTableInput } from '@core/data/schemas'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { Settings2SolidIcon } from 'pixel-art-icons/icons/settings-2-solid'
import { useEditorStore } from '@site/store/store'
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
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>
  onDeleteTable: () => Promise<void>
  /** Navigate the Content page to edit this post-type row. */
  onEditInContent?: (row: DataRow) => void
  /** Navigate the Site editor to open this page or component row. */
  onOpenInSiteEditor?: (row: DataRow) => void
  onPublishRow?: (rowId: string) => Promise<DataRow>
  onSetRowStatus?: (rowId: string, status: 'draft' | 'unpublished') => Promise<DataRow>
  canEdit: boolean
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
  onUpdateTable,
  onDeleteTable,
  onEditInContent,
  onOpenInSiteEditor,
  onPublishRow,
  onSetRowStatus,
  canEdit,
  canDelete,
}: DataInspectorProps): ReactElement {
  const setPropertiesPanel = useEditorStore((s) => s.setPropertiesPanel)

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
        onClose={() => setPropertiesPanel({ collapsed: true })}
      />

      <div className={styles.body}>
        {row !== null ? (
          <RowDetail
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
          />
        ) : (
          <TableSettings
            table={table}
            tables={tables}
            rows={rows}
            onUpdateTable={onUpdateTable}
            onDeleteTable={onDeleteTable}
            canEdit={canEdit}
            canDelete={canDelete}
          />
        )}
      </div>
    </aside>
  )
}
