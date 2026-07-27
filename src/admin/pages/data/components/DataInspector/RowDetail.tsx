import { useState, type ReactElement, type ReactNode } from 'react'
import { Button } from '@ui/components/Button'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { LayoutSolidIcon } from 'pixel-art-icons/icons/layout-solid'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { CellEditorRenderer } from '@admin/pages/data/components/DataGrid/cells/CellEditorRenderer'
import { RelationPickerDialog } from '@admin/pages/data/components/RelationPickerDialog/RelationPickerDialog'
import { PageAccessDialog, type PageAccessPayload } from '@admin/shared/dialogs/PageAccessDialog'
import { useAsyncResource } from '@admin/lib/useAsyncResource'
import { useDataRowDraft } from '@admin/pages/data/hooks/useDataRowDraft'
import { emptyCellValue } from '@admin/pages/data/utils/fieldDefaults'
import { isBuiltInValueLocked } from '@core/data/systemTableGuard'
import { pageFromRow } from '@core/data/pageFromRow'
import { resolvePageAccess, type PageAccess } from '@core/page-tree'
import { listVisitorGroups, type VisitorGroup } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
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
  /** Persist a page's access (Public / group-restricted) — pages write via site-document, not the data grid. */
  onSavePageAccess: (row: DataRow, access: PageAccess) => Promise<void>
  /** Navigate the Content page to edit this post-type row. */
  onEditInContent?: (row: DataRow) => void
  /** Navigate the Site editor to open this page or component row. */
  onOpenInSiteEditor?: (row: DataRow) => void
  onPublishRow?: (rowId: string) => Promise<DataRow>
  onSetRowStatus?: (rowId: string, status: 'draft' | 'unpublished') => Promise<DataRow>
  /** Resolve a row id to a row object for display in relation cells. */
  resolveRow: (rowId: string) => DataRow | null
  canEdit: boolean
}

interface PickerState {
  fieldId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
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
}: {
  row: DataRow
  table: DataTable
  tables: DataTable[]
  onSaveRow: (rowId: string, cells: DataRowCells) => Promise<DataRow>
  resolveRow: (rowId: string) => DataRow | null
  canEdit: boolean
  /** Forwarded to PageTreeCell — opens the visual editor for this row. */
  onOpenEditor?: () => void
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

  return (
    <>
      <div className={styles.section}>
        {table.fields.map((field) => (
          <label key={field.id} className={styles.formGroup}>
            <span className={styles.label}>{field.label}</span>
            {field.description && (
              <span className={styles.labelDescription}>{field.description}</span>
            )}
            <CellEditorRenderer
              field={field}
              value={draft.cells[field.id] ?? emptyCellValue(field)}
              onChange={(next) => draft.setCell(field.id, next)}
              onCommit={() => void draft.flush()}
              context="detail"
              readOnly={!canEdit || isBuiltInValueLocked(table, field)}
              rowId={row.id}
              resolveRelationTarget={resolveRow}
              onOpenPicker={
                field.type === 'relation'
                  ? () => setPickerState({ fieldId: field.id })
                  : undefined
              }
              onOpenEditor={field.type === 'pageTree' ? onOpenEditor : undefined}
            />
          </label>
        ))}

        <div className={styles.saveStatus} aria-live="polite" aria-atomic="true">
          {draft.isSaving && (
            <span className={styles.savingText}>Saving…</span>
          )}
          {!draft.isSaving && draft.saveError && (
            <span className={styles.saveErrorText} role="alert">{draft.saveError}</span>
          )}
          {!draft.isSaving && !draft.saveError && !draft.isDirty && (
            <span className={styles.savedText}>Saved</span>
          )}
        </div>
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
// PageAccessSection — per-page access control (D14).
//
// The Data workspace mirrors the Site editor's PageAccessDialog so an admin
// can set a page's access (Public / group-restricted) from the same place they
// edit title/slug/SEO. Access is page-level, not a data-grid cell: every
// built-in field on the `pages` system table is value-locked, so the data-rows
// PATCH can't carry it (it 400s on `title` for a full-cells write and would
// wipe the row on a partial). The control reads the current access from
// `cells.access` via `resolvePageAccess` and persists changes through the
// site-document transaction (`onSavePageAccess`) — the same path the Site
// editor's `setPageAccess` uses.
// ---------------------------------------------------------------------------

/**
 * One-line access summary for the section. Resolves group ids to names via
 * the loaded group list; ids that no longer match a group are surfaced as an
 * "N unavailable" tail so a deleted group is never silently hidden.
 */
function accessSummary(
  access: { level: 'public' | 'groups'; groups: string[] },
  groups: VisitorGroup[],
): string {
  if (access.level === 'public') return 'Public — anyone can view'
  const byId = new Map(groups.map((g) => [g.id, g.name]))
  const known: string[] = []
  let unknownCount = 0
  for (const id of access.groups) {
    const name = byId.get(id)
    if (name) known.push(name)
    else unknownCount += 1
  }
  const parts = known.slice()
  if (unknownCount > 0) parts.push(`${unknownCount} unavailable`)
  return `Restricted: ${parts.join(', ')}`
}

function PageAccessSection({
  row,
  onSavePageAccess,
  canEdit,
}: {
  row: DataRow
  onSavePageAccess: (row: DataRow, access: PageAccess) => Promise<void>
  canEdit: boolean
}): ReactElement {
  const [dialogOpen, setDialogOpen] = useState(false)
  const access = resolvePageAccess(row.cells.access)
  // Best-effort load of the group list (the same list the Members workspace
  // manages) so the summary can resolve ids to names. A failed load leaves an
  // empty list — the level is still readable and the dialog re-loads its own.
  const { data: groups } = useAsyncResource(() => listVisitorGroups(), [], { swallowErrors: true })
  const loadedGroups: VisitorGroup[] = groups ?? []
  const pageTitle = typeof row.cells.title === 'string' ? row.cells.title : row.id

  async function handleSave(payload: PageAccessPayload) {
    try {
      await onSavePageAccess(row, payload.access)
      setDialogOpen(false)
    } catch (err) {
      console.error('[data-inspector] Page access save failed:', err)
      pushToast({
        kind: 'error',
        title: 'Could not save access',
        body: getErrorMessage(err, 'Failed to save page access.'),
      })
    }
  }

  return (
    <div className={styles.section}>
      <div className={styles.accessRow}>
        <div className={styles.accessLabelCol}>
          <span className={styles.label}>Member access</span>
          <span className={styles.caption}>{accessSummary(access, loadedGroups)}</span>
        </div>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => setDialogOpen(true)}
          disabled={!canEdit}
          aria-label={`Manage member access for ${pageTitle}`}
        >
          <LockSolidIcon size={12} aria-hidden="true" />
          Manage access…
        </Button>
      </div>

      {dialogOpen && (
        <PageAccessDialog
          page={pageFromRow(row)}
          onCancel={() => setDialogOpen(false)}
          onSave={(payload) => { void handleSave(payload) }}
        />
      )}
    </div>
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
  onSavePageAccess,
  onEditInContent,
  onOpenInSiteEditor,
  onPublishRow: _onPublishRow,
  onSetRowStatus: _onSetRowStatus,
  resolveRow,
  canEdit,
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
      />
      {table.kind === 'page' && (
        <PageAccessSection row={row} onSavePageAccess={onSavePageAccess} canEdit={canEdit} />
      )}
    </>
  )
}
