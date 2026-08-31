import { useEffect, useEffectEvent, useState, type ReactElement, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { CellEditorRenderer } from '@admin/pages/data/components/DataGrid/cells/CellEditorRenderer'
import { RelationPickerDialog } from '@admin/pages/data/components/RelationPickerDialog/RelationPickerDialog'
import { useDataRowDraft } from '@admin/pages/data/hooks/useDataRowDraft'
import { emptyCellValue } from '@admin/pages/data/utils/fieldDefaults'
import { formatDateTime, SHORT_DATE_TIME } from '@admin/lib/formatDateTime'
import type { DataTable, DataRow, DataRowCells } from '@core/data/schemas'
import type { DataField } from '@core/data/schemas'
import styles from './DataInspector.module.css'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RowDetailProps {
  row: DataRow
  table: DataTable
  tables: DataTable[]
  onSaveRow: (rowId: string, cells: DataRowCells) => Promise<DataRow>
  /** Navigate the Content page to edit this post-type row. */
  onEditInContent?: (row: DataRow) => void
  /** Navigate the Site editor to open this page or component row. */
  onOpenInSiteEditor?: (row: DataRow) => void
  onPublishRow?: (rowId: string) => Promise<DataRow>
  onSetRowStatus?: (rowId: string, status: 'draft' | 'unpublished') => Promise<DataRow>
  /** Resolve a row id to a row object for display in relation cells. */
  resolveRow: (rowId: string) => DataRow | null
  canEdit: boolean
  onDraftStateChange?: (state: DataRowDraftState | null) => void
}

export interface DataRowDraftState {
  isDirty: boolean
  isSaving: boolean
  saveError: string | null
  flush: () => Promise<DataRow | null>
}

interface PickerState {
  fieldId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso, SHORT_DATE_TIME) : '—'
}

function statusPillClass(status: DataRow['status']): string {
  switch (status) {
    case 'published': return styles.statusPublished
    case 'unpublished': return styles.statusUnpublished
    default: return styles.statusDraft
  }
}

function statusLabel(status: DataRow['status']): string {
  switch (status) {
    case 'published': return 'Published'
    case 'unpublished': return 'Unpublished'
    default: return 'Draft'
  }
}

function authorDisplayName(row: DataRow): string {
  const user = row.author ?? row.createdBy ?? row.updatedBy
  if (user?.displayName) return user.displayName
  if (user?.email) return user.email
  return '—'
}

function primaryDisplayValue(row: DataRow, table: DataTable): string {
  const v = row.cells[table.primaryFieldId]
  if (typeof v === 'string' && v.length > 0) return v
  return row.id
}

// ---------------------------------------------------------------------------
// RowHeaderCard — title + status + a single action button.
//
// Used for the three kinds that have a separate rich editor: `postType`
// (Edit in Content), `page` and `component` (Open in Site editor). The
// action button is wired by the parent through `onAction`.
// ---------------------------------------------------------------------------

function RowHeaderCard({
  primaryValue,
  status,
  actionLabel,
  actionIcon,
  actionAriaLabel,
  onAction,
}: {
  primaryValue: string
  status: DataRow['status']
  actionLabel: string
  actionIcon: ReactNode
  actionAriaLabel: string
  onAction?: () => void
}): ReactElement {
  return (
    <div className={styles.rowHeaderCard}>
      <div className={styles.rowHeaderTitleRow}>
        <span className={styles.rowHeaderTitle}>{primaryValue || '(untitled)'}</span>
        <span className={`${styles.statusPill} ${statusPillClass(status)}`}>
          {statusLabel(status)}
        </span>
      </div>

      <Button
        variant="primary"
        size="sm"
        fullWidth
        onClick={() => onAction?.()}
        disabled={!onAction}
        aria-label={actionAriaLabel}
      >
        {actionIcon}
        {actionLabel}
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RowMetaBlock — created / updated / published / author summary.
// ---------------------------------------------------------------------------

function RowMetaBlock({ row }: { row: DataRow }): ReactElement {
  return (
    <div className={styles.metaBlock}>
      <div className={styles.metaItem}>
        <span className={styles.metaKey}>Created</span>
        <span className={styles.metaValue}>{formatDate(row.createdAt)}</span>
      </div>
      <div className={styles.metaItem}>
        <span className={styles.metaKey}>Updated</span>
        <span className={styles.metaValue}>{formatDate(row.updatedAt)}</span>
      </div>
      <div className={styles.metaItem}>
        <span className={styles.metaKey}>Published</span>
        <span className={styles.metaValue}>{formatDate(row.publishedAt)}</span>
      </div>
      <div className={styles.metaItem}>
        <span className={styles.metaKey}>Author</span>
        <span className={styles.metaValue}>{authorDisplayName(row)}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DataRowForm — inline-editable fields.
// ---------------------------------------------------------------------------

function DataRowForm({
  row,
  table,
  tables,
  onSaveRow,
  resolveRow,
  canEdit,
  onOpenEditor,
  onDraftStateChange,
}: {
  row: DataRow
  table: DataTable
  tables: DataTable[]
  onSaveRow: (rowId: string, cells: DataRowCells) => Promise<DataRow>
  resolveRow: (rowId: string) => DataRow | null
  canEdit: boolean
  /** Forwarded to PageTreeCell — opens the visual editor for this row. */
  onOpenEditor?: () => void
  onDraftStateChange?: (state: DataRowDraftState | null) => void
}): ReactElement {
  const draft = useDataRowDraft(row, onSaveRow)
  const [pickerState, setPickerState] = useState<PickerState | null>(null)

  // Derive picker props from pickerState
  const pickerField: DataField | null = pickerState
    ? (table.fields.find((f) => f.id === pickerState.fieldId) ?? null)
    : null

  const pickerTargetTable = pickerField?.type === 'relation'
    ? (tables.find((t) => t.id === pickerField.targetTableId) ?? null)
    : null

  const pickerCurrentValue = pickerState
    ? ((draft.cells[pickerState.fieldId] ?? null) as string | string[] | null)
    : null

  const pickerAllowMultiple = pickerField?.type === 'relation'
    ? (pickerField.allowMultiple ?? false)
    : false

  const reportDraftState = useEffectEvent(() => {
    onDraftStateChange?.({
      isDirty: draft.isDirty,
      isSaving: draft.isSaving,
      saveError: draft.saveError,
      flush: draft.flush,
    })
  })
  useEffect(() => {
    reportDraftState()
    return () => onDraftStateChange?.(null)
  }, [draft.isDirty, draft.isSaving, draft.saveError, onDraftStateChange])

  return (
    <>
      <div className={styles.section}>
        {table.fields.map((field) => (
          <div key={field.id} className={styles.formGroup}>
            {field.type !== 'repeater' && (
              <>
                <span className={styles.label}>{field.label}</span>
                {field.description && (
                  <span className={styles.labelDescription}>{field.description}</span>
                )}
              </>
            )}
            <CellEditorRenderer
              field={field}
              value={draft.cells[field.id] ?? emptyCellValue(field)}
              onChange={(next) => draft.setCell(field.id, next)}
              onCommit={() => void draft.flush()}
              context="detail"
              readOnly={!canEdit}
              rowId={row.id}
              tables={tables}
              resolveRelationTarget={resolveRow}
              onOpenPicker={
                field.type === 'relation'
                  ? () => setPickerState({ fieldId: field.id })
                  : undefined
              }
              onOpenEditor={field.type === 'pageTree' ? onOpenEditor : undefined}
            />
          </div>
        ))}

        {(draft.isSaving || draft.saveError) && (
          <div className={styles.saveStatus} aria-live="polite" aria-atomic="true">
            {draft.isSaving && (
              <span className={styles.savingText}>Saving…</span>
            )}
            {!draft.isSaving && draft.saveError && (
              <span className={styles.saveErrorText} role="alert">{draft.saveError}</span>
            )}
          </div>
        )}
      </div>

      <RelationPickerDialog
        open={pickerState !== null}
        onClose={() => setPickerState(null)}
        targetTable={pickerTargetTable}
        currentValue={pickerCurrentValue}
        allowMultiple={pickerAllowMultiple}
        onPick={(next) => {
          if (pickerState) {
            draft.setCell(pickerState.fieldId, next)
            void draft.flush()
          }
          setPickerState(null)
        }}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// RowDetail
//
// Composition rules per kind:
//
//   - `postType`  → RowHeaderCard (Edit in Content) + RowMetaBlock + DataRowForm
//   - `page`      → RowHeaderCard (Open in Site editor) + RowMetaBlock + DataRowForm
//   - `component` → RowHeaderCard (Open in Site editor) + RowMetaBlock + DataRowForm
//   - `data`      → DataRowForm only (no rich editor, no publish lifecycle)
//
// `onEditInContent` and `onOpenInSiteEditor` are the two navigation handlers
// the parent (DataPage) wires up. Only one is consumed per row based on the
// table's `kind`.
// ---------------------------------------------------------------------------

export function RowDetail({
  row,
  table,
  tables,
  onSaveRow,
  onEditInContent,
  onOpenInSiteEditor,
  onPublishRow: _onPublishRow,
  onSetRowStatus: _onSetRowStatus,
  resolveRow,
  canEdit,
  onDraftStateChange,
}: RowDetailProps): ReactElement {
  const showHeader = table.kind === 'postType' || table.kind === 'page' || table.kind === 'component'

  // Pick the right action for the header card based on kind. The handlers
  // are wired at the DataPage level; here we just dispatch on `kind`.
  const primaryValue = primaryDisplayValue(row, table)
  let headerCard: ReactElement | null = null

  if (table.kind === 'postType') {
    headerCard = (
      <RowHeaderCard
        primaryValue={primaryValue}
        status={row.status}
        actionLabel="Edit in Content"
        actionIcon={<ExternalLinkSolidIcon size={12} aria-hidden="true" />}
        actionAriaLabel={`Edit ${primaryValue} in Content`}
        onAction={onEditInContent ? () => onEditInContent(row) : undefined}
      />
    )
  } else if (table.kind === 'page' || table.kind === 'component') {
    headerCard = (
      <RowHeaderCard
        primaryValue={primaryValue}
        status={row.status}
        actionLabel="Open in Site editor"
        actionIcon={<LayoutSolidIcon size={12} aria-hidden="true" />}
        actionAriaLabel={`Open ${primaryValue} in Site editor`}
        onAction={onOpenInSiteEditor ? () => onOpenInSiteEditor(row) : undefined}
      />
    )
  }

  // Wire the inline body cell's "Open editor →" button for page/component kinds.
  const formOpenEditor = (table.kind === 'page' || table.kind === 'component') && onOpenInSiteEditor
    ? () => onOpenInSiteEditor(row)
    : undefined

  return (
    <>
      {showHeader && (
        <div className={styles.section}>
          {headerCard}
          <RowMetaBlock row={row} />
        </div>
      )}
      <DataRowForm
        row={row}
        table={table}
        tables={tables}
        onSaveRow={onSaveRow}
        resolveRow={resolveRow}
        canEdit={canEdit}
        onOpenEditor={formOpenEditor}
        onDraftStateChange={onDraftStateChange}
      />
    </>
  )
}
