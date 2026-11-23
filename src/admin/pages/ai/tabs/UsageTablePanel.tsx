/**
 * UsageTablePanel — the shared scaffolding behind every audit table.
 *
 * The audit view shows several usage rollups (by model, by user, by surface)
 * that are the same table dressed in different columns: a titled panel header
 * with a count hint, a `Chats / … / Spend` numeric-aligned `<thead>`, one row
 * per record, and a single colSpan-spanning empty row when there's nothing to
 * show. This component owns that scaffolding so each rollup is reduced to a
 * `columns` config plus the panel's label/hint — adding a column or changing
 * the empty state is one edit here, not one per panel.
 */

import type { ReactNode } from 'react'
import { cn } from '@ui/cn'
import audit from '@admin/shared/AuditTable/AuditTable.module.css'
import styles from '@admin/shared/SettingsWorkspace/SettingsWorkspace.module.css'

export type UsageTableColumn<TRow> = {
  /** Header text; also the React key for the column. */
  header: string
  /** Right-align the header + body cells as a numeric column. */
  numeric?: boolean
  /** Extra class for the body cell (e.g. a scope-label style). */
  cellClassName?: string
  /** Render the cell content for one row. */
  cell: (row: TRow) => ReactNode
}

export function UsageTablePanel<TRow>({
  title,
  hint,
  columns,
  rows,
  rowKey,
  emptyLabel,
}: {
  title: string
  hint: string
  columns: ReadonlyArray<UsageTableColumn<TRow>>
  rows: ReadonlyArray<TRow>
  rowKey: (row: TRow) => string
  emptyLabel: string
}) {
  return (
    <div className={styles.auditPanel}>
      <div className={styles.auditPanelHeader}>
        <h3 className={styles.auditPanelTitle}>{title}</h3>
        <span className={styles.auditPanelHint}>{hint}</span>
      </div>
      <div className={styles.auditTableScroll}>
        <table className={cn(audit.table, styles.auditTable)}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.header} className={col.numeric ? styles.numeric : undefined}>
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={styles.auditEmptyRow}>
                  {emptyLabel}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((col) => (
                    <td
                      key={col.header}
                      className={cn(col.numeric && styles.numeric, col.cellClassName) || undefined}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
