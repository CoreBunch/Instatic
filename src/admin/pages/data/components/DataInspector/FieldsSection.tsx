/**
 * FieldsSection — the "Fields" block rendered inside TableSettings. Owns the
 * field list state: drag-and-drop reorder, inline edit (FieldEditForm), delete
 * (via useConfirmDelete), and new-field creation (NewFieldDialog).
 *
 * Presentation is split out: each row is a FieldRow, each open editor is a
 * FieldEditForm. Field classification lives in fieldGuards; the editable draft
 * shape and its conversions live in fieldEditState.
 */
import { getErrorMessage } from '@core/utils/errorMessage'
import { useState } from 'react'
import type { ReactElement, DragEvent } from 'react'
import { Button } from '@ui/components/Button'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { NewFieldDialog } from '@admin/pages/data/components/NewFieldDialog/NewFieldDialog'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { StepUpCancelledMessage } from '@admin/shared/StepUp'
import {
  POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS,
  type DataField,
  type DataTable,
  type UpdateDataTableInput,
} from '@core/data/schemas'
import { FieldEditForm } from './FieldEditForm'
import { FieldRow } from './FieldRow'
import {
  deleteTooltip,
  isFieldDeletable,
  isLabelLocked,
  isMandatoryField,
  isOptionalBuiltIn,
} from './fieldGuards'
import {
  applyEditState,
  fieldToEditState,
  makeOption,
  slugifyOptionValue,
  type DraftOption,
  type FieldEditState,
} from './fieldEditState'
import styles from './DataInspector.module.css'

// ---------------------------------------------------------------------------
// Module-level helper — extracted so the React Compiler can auto-memoize the
// FieldsSection component body (try/catch in async causes compiler bailout
// when nested inside a component function).
// ---------------------------------------------------------------------------

function isStepUpCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === StepUpCancelledMessage
}

async function saveFieldEdit(
  editingFieldId: string,
  editState: FieldEditState,
  table: DataTable,
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>,
  setEditSaving: (v: boolean) => void,
  setEditError: (v: string | null) => void,
  setEditingFieldId: (v: string | null) => void,
  setEditState: (v: FieldEditState | null) => void,
): Promise<void> {
  const field = table.fields.find((f) => f.id === editingFieldId)
  if (!field) return

  const locked = isLabelLocked(field, table)
  const updated = applyEditState(field, editState, locked)
  const updatedFields = table.fields.map((f) => (f.id === editingFieldId ? updated : f))

  setEditSaving(true)
  setEditError(null)
  try {
    await onUpdateTable({ fields: updatedFields })
    setEditingFieldId(null)
    setEditState(null)
  } catch (err) {
    if (isStepUpCancelled(err)) return
    console.error('[FieldsSection] Save failed:', err)
    setEditError(getErrorMessage(err, 'Could not save field'))
  } finally {
    setEditSaving(false)
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldsSectionProps {
  table: DataTable
  tables: DataTable[]
  /** Total row count — used in the field-delete confirmation message. */
  rowCount: number
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>
  canEdit: boolean
}

// ---------------------------------------------------------------------------
// FieldsSection
// ---------------------------------------------------------------------------

export function FieldsSection({
  table,
  tables,
  rowCount,
  onUpdateTable,
  canEdit,
}: FieldsSectionProps): ReactElement {
  const confirmDelete = useConfirmDelete()

  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [editState, setEditState] = useState<FieldEditState | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [newFieldDialogOpen, setNewFieldDialogOpen] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)

  // Dragging is allowed for all tables; mandatory postType fields are excluded
  // from drag-and-drop because they're rendered as locked rows.
  const canDragField = (field: DataField): boolean => {
    if (!canEdit) return false
    if (table.kind === 'postType' && isMandatoryField(field.id)) return false
    return true
  }

  // ── Drag-and-drop ──

  function handleDragStart(e: DragEvent<HTMLDivElement>, fieldId: string) {
    e.dataTransfer.setData('text/plain', fieldId)
    e.dataTransfer.effectAllowed = 'move'
    setDraggingId(fieldId)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>, fieldId: string) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(fieldId)
  }

  function handleDragLeave() {
    setDragOverId(null)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>, targetFieldId: string) {
    e.preventDefault()
    const sourceId = draggingId ?? e.dataTransfer.getData('text/plain')
    setDraggingId(null)
    setDragOverId(null)

    if (!sourceId || sourceId === targetFieldId) return

    const fromIndex = table.fields.findIndex((f) => f.id === sourceId)
    const toIndex = table.fields.findIndex((f) => f.id === targetFieldId)
    if (fromIndex === -1 || toIndex === -1) return

    const reordered = [...table.fields]
    const [moved] = reordered.splice(fromIndex, 1)
    if (!moved) return
    reordered.splice(toIndex, 0, moved)

    setUpdateError(null)
    onUpdateTable({ fields: reordered }).catch((err) => {
      if (isStepUpCancelled(err)) return
      console.error('[FieldsSection] Reorder failed:', err)
      setUpdateError(getErrorMessage(err, 'Could not reorder fields'))
    })
  }

  function handleDragEnd() {
    setDraggingId(null)
    setDragOverId(null)
  }

  // ── Inline edit ──

  function startEdit(field: DataField) {
    setEditingFieldId(field.id)
    setEditState(fieldToEditState(field))
    setEditError(null)
  }

  function cancelEdit() {
    setEditingFieldId(null)
    setEditState(null)
    setEditError(null)
  }

  function updateEditState<K extends keyof FieldEditState>(key: K, value: FieldEditState[K]) {
    setEditState((prev) => (prev ? { ...prev, [key]: value } : null))
  }

  function updateEditOption(index: number, patch: Partial<DraftOption>) {
    setEditState((prev) => {
      if (!prev) return null
      const updated = prev.selectOptions.map((opt, i) => {
        if (i !== index) return opt
        const next = { ...opt, ...patch }
        if ('label' in patch && !('value' in patch)) {
          next.value = slugifyOptionValue(next.label)
        }
        return next
      })
      return { ...prev, selectOptions: updated }
    })
  }

  function removeEditOption(index: number) {
    setEditState((prev) =>
      prev ? { ...prev, selectOptions: prev.selectOptions.filter((_, i) => i !== index) } : null,
    )
  }

  function addEditOption() {
    setEditState((prev) =>
      prev ? { ...prev, selectOptions: [...prev.selectOptions, makeOption('')] } : null,
    )
  }

  async function saveEdit() {
    if (!editingFieldId || !editState) return
    await saveFieldEdit(
      editingFieldId,
      editState,
      table,
      onUpdateTable,
      setEditSaving,
      setEditError,
      setEditingFieldId,
      setEditState,
    )
  }

  // ── Delete ──

  function requestDeleteField(field: DataField) {
    const rowDescription = rowCount > 0
      ? `This will permanently delete the field and all values across ${rowCount} row${rowCount === 1 ? '' : 's'}.`
      : undefined
    confirmDelete({
      title: `Delete field "${field.label}"?`,
      description: rowDescription,
      commit: () => {
        const updatedFields = table.fields.filter((f) => f.id !== field.id)
        setUpdateError(null)
        onUpdateTable({ fields: updatedFields }).catch((err) => {
          if (isStepUpCancelled(err)) return
          console.error('[FieldsSection] Delete field failed:', err)
          setUpdateError(getErrorMessage(err, 'Could not delete field'))
        })
      },
    })
  }

  // ── New field ──

  async function handleNewField(field: DataField) {
    await onUpdateTable({ fields: [...table.fields, field] })
    setNewFieldDialogOpen(false)
  }

  // Compute which optional built-in field IDs are absent from the table
  // (so NewFieldDialog can offer quick-add buttons for them).
  const missingOptionalBuiltInIds = table.kind === 'postType'
    ? (POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS as readonly string[]).filter(
        (id) => !table.fields.some((f) => f.id === id),
      )
    : []

  // ── Render ──

  return (
    <div className={styles.fieldsSectionBody}>
      {updateError && (
        <p role="alert" className={styles.errorBanner}>{updateError}</p>
      )}

      <div className={styles.fieldList}>
        {table.fields.map((field) => {
          const mandatory = table.kind === 'postType' && isMandatoryField(field.id)
          const isEditing = editingFieldId === field.id

          return (
            <div key={field.id}>
              <FieldRow
                field={field}
                canDrag={canDragField(field)}
                canEdit={canEdit}
                deletable={isFieldDeletable(field, table)}
                deleteTooltip={deleteTooltip(field, table)}
                mandatory={mandatory}
                optionalBuiltIn={isOptionalBuiltIn(field)}
                isEditing={isEditing}
                isDragOver={dragOverId === field.id}
                isDragging={draggingId === field.id}
                onEditToggle={() => (isEditing ? cancelEdit() : startEdit(field))}
                onDelete={() => requestDeleteField(field)}
                onDragStart={(e) => handleDragStart(e, field.id)}
                onDragOver={(e) => handleDragOver(e, field.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, field.id)}
                onDragEnd={handleDragEnd}
              />

              {/* Inline edit form */}
              {isEditing && editState && (
                <FieldEditForm
                  field={field}
                  tables={tables}
                  state={editState}
                  saving={editSaving}
                  error={editError}
                  labelLocked={isLabelLocked(field, table)}
                  onChange={updateEditState}
                  onOptionUpdate={updateEditOption}
                  onOptionRemove={removeEditOption}
                  onOptionAdd={addEditOption}
                  onSave={() => void saveEdit()}
                  onCancel={cancelEdit}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Add field */}
      {canEdit && (
        <Button
          variant="primary"
          size="sm"
          type="button"
          align="start"
          onClick={() => setNewFieldDialogOpen(true)}
        >
          <PlusIcon size={12} aria-hidden="true" />
          Add field
        </Button>
      )}

      <NewFieldDialog
        open={newFieldDialogOpen}
        onClose={() => setNewFieldDialogOpen(false)}
        existingFieldIds={table.fields.map((f) => f.id)}
        tables={tables}
        missingOptionalBuiltInIds={missingOptionalBuiltInIds}
        onCreate={handleNewField}
      />
    </div>
  )
}
