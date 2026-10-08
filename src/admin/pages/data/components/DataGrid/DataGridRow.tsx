/**
 * DataGridRow — read-only display row in the DataGrid.
 *
 * Cells render as presentational chips / thumbnails / formatted values via
 * `CellDisplayRenderer`. Editing happens in the row inspector — clicking
 * the row calls `onSelect` which opens the inspector.
 *
 * The primary cell is special: it shows the row's title plus an optional
 * `/slug` subtitle (post-type tables), with a status dot for postType.
 */
import type { CSSProperties, ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { Checkbox } from '@ui/components/Checkbox'
import { cn } from '@ui/cn'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { OpenSolidIcon } from 'pixel-art-icons/icons/open-solid'
import { useLocalizedData } from '@admin/pages/data/localizedData'
import { readDisplayTitle, readStringCell } from '@core/data/cells'
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import { CellDisplayRenderer } from './cells/CellDisplayRenderer'
import styles from './DataGrid.module.css'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DataGridRowProps {
  row: DataRow
  /** Field order to render — DataGrid reorders so primary comes first and
   *  filters out fields that are collapsed into the primary subtitle. */
  fields: DataField[]
  /** The table's primary field id. */
  primaryFieldId: string
  /** Field id whose value is rendered as a subtitle under the primary cell.
   *  Typically `'slug'` for post-types; `null` otherwise. */
  subtitleFieldId: string | null
  table: DataTable
  /** Full tables list — for resolving cross-table relation labels. */
  tables: DataTable[]
  /** All rows in the active table — for in-table relation labels. */
  rows: DataRow[]
  resolveRelationTarget?: (id: string) => DataRow | null
  selected: boolean
  /** True when the row's checkbox is ticked (bulk-select). */
  checked: boolean
  readOnly?: boolean
  /** Render the colored status dot inside the primary cell. PostType only. */
  showStatusDot: boolean
  onSelect: () => void
  onCheckedChange: (next: boolean) => void
  /** 'Edit in Content' (postType) or 'Open' (data). Omit to hide the button. */
  onPrimaryAction?: () => void
  /** Delete row. Omit to hide the delete button. */
  onDelete?: () => void
  /** Inline style for the sticky primary cell (provides `left`). */
  primaryStickyLeft: CSSProperties
  /** Inline style for the sticky checkbox cell (provides `left: 0`). */
  checkboxStickyLeft: CSSProperties
}

// ---------------------------------------------------------------------------
// DataGridRow
// ---------------------------------------------------------------------------

export function DataGridRow({
  row,
  fields,
  primaryFieldId,
  subtitleFieldId,
  table,
  tables,
  rows,
  resolveRelationTarget,
  selected,
  checked,
  readOnly: _readOnly,
  showStatusDot,
  onSelect,
  onCheckedChange,
  onPrimaryAction,
  onDelete,
  primaryStickyLeft,
  checkboxStickyLeft,
}: DataGridRowProps): ReactElement {
  const isPostType = table.kind === 'postType'

  const primaryActionLabel = isPostType ? 'Edit in Content' : 'Open'
  const PrimaryActionIcon = isPostType ? EditSolidIcon : OpenSolidIcon

  // Resolve primary title + subtitle.
  const localization = useLocalizedData()
  const primaryValue = readDisplayTitle(row.cells, table, localization?.context)
  const subtitleValue = subtitleFieldId
    ? readStringCell(row.cells, subtitleFieldId)
    : ''

  // Clicking the checkbox or trailing actions cells shouldn't trigger row-select.
  function stopRowClick(e: React.MouseEvent) {
    e.stopPropagation()
  }

  return (
    <div
      role="row"
      className={cn(styles.row)}
      aria-selected={selected}
      data-selected={selected ? 'true' : undefined}
      data-checked={checked ? 'true' : undefined}
      data-data-grid-row-id={row.id}
      onClick={onSelect}
    >
      {/* Leading checkbox cell — sticky to the left edge */}
      <div
        role="gridcell"
        className={styles.cell}
        data-sticky="checkbox"
        data-data-grid-row-id={row.id}
        style={checkboxStickyLeft}
        onClick={stopRowClick}
      >
        <Checkbox
          boxSize="sm"
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={checked ? `Deselect row ${row.id}` : `Select row ${row.id}`}
        />
      </div>

      {fields.map((field) => {
        const isPrimary = field.id === primaryFieldId
        if (isPrimary) {
          return (
            <div
              key={field.id}
              role="gridcell"
              className={cn(styles.cell, styles.primaryCell)}
              data-sticky="primary"
              data-data-grid-row-id={row.id}
              style={primaryStickyLeft}
            >
              {showStatusDot && (
                <span
                  className={styles.statusDot}
                  data-status={row.status}
                  aria-label={`Status: ${row.status}`}
                />
              )}
              <span className={styles.primaryStack}>
                {primaryValue.length > 0 ? (
                  <span className={styles.primaryTitle}>{primaryValue}</span>
                ) : (
                  <span className={cn(styles.primaryTitle, styles.empty)}>—</span>
                )}
                {subtitleFieldId && subtitleValue.length > 0 && (
                  <span className={styles.primarySubtitle}>/{subtitleValue}</span>
                )}
              </span>
            </div>
          )
        }
        return (
          <div
            key={field.id}
            role="gridcell"
            className={styles.cell}
            data-data-grid-row-id={row.id}
          >
            <CellDisplayRenderer
              field={field}
              cells={row.cells}
              tables={tables}
              rows={rows} resolveRelationTarget={resolveRelationTarget}
            />
          </div>
        )
      })}

      {/* Trailing actions column */}
      <div
        role="gridcell"
        className={styles.actionsCell}
        data-data-grid-row-id={row.id}
        onClick={stopRowClick}
      >
        <div className={styles.actions}>
          {onPrimaryAction && (
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label={primaryActionLabel}
              tooltip={primaryActionLabel}
              onClick={(e) => {
                e.stopPropagation()
                onPrimaryAction()
              }}
            >
              <PrimaryActionIcon size={12} aria-hidden="true" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              aria-label="Delete row"
              tooltip="Delete row"
              tone="danger"
              dangerHover
              onClick={(e) => {
                e.stopPropagation()
                onDelete()
              }}
            >
              <TrashSolidIcon size={12} aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>

    </div>
  )
}
