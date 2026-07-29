/**
 * THESIS: A collection schema should read like a small, editable blueprint.
 * OWN-WORLD: Instatic's compact surfaces, quiet borders, pixel icons, and
 * deliberate state color remain the visual vocabulary.
 * STORY: Understand the schema, add or refine a field, then reorder the final
 * record shape without leaving the current task.
 * FIRST VIEWPORT: The schema title, field count, ordered rows, and add action
 * stay visible together.
 * FORM: A dense blueprint list with modal detail editing.
 */
import { useState, type DragEvent, type ReactElement } from 'react'
import type { IconComponent } from 'pixel-art-icons/types'
import { Button } from '@ui/components/Button'
import { Section } from '@ui/components/Section'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { NewFieldDialog } from '@admin/pages/data/components/NewFieldDialog/NewFieldDialog'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import type { DataField, DataTable } from '@core/data/schemas'
import { getErrorMessage } from '@core/utils/errorMessage'
import { pushToast } from '@ui/components/Toast'
import { FieldRow } from '../DataInspector/FieldRow'
import { isPrimaryFieldCandidate } from '@core/data/fields'
import styles from './FieldSchemaComposer.module.css'

interface FieldSchemaComposerProps {
  fields: DataField[]
  tables: DataTable[]
  onChange: (fields: DataField[]) => Promise<void> | void
  canEdit?: boolean
  title?: string
  description?: string | null
  sectionTitle?: string
  sectionIcon?: IconComponent
  primaryFieldId?: string
  onPrimaryFieldChange?: (fieldId: string) => Promise<void> | void
  addLabel?: string
  emptyMessage?: string
  lockedFieldIds?: readonly string[]
  undeletableFieldIds?: readonly string[]
  builtInFieldIds?: readonly string[]
  labelLockedFieldIds?: readonly string[]
  missingOptionalBuiltInIds?: readonly string[]
  deleteValueWarning?: string
}

function isStepUpCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'Step-up cancelled'
}

export function FieldSchemaComposer({
  fields,
  tables,
  onChange,
  canEdit = true,
  title = 'Fields',
  description = 'Define the shape and order of each record.',
  sectionTitle,
  sectionIcon,
  primaryFieldId,
  onPrimaryFieldChange,
  addLabel = 'Add field',
  emptyMessage = 'No fields yet. Add the first field to give each record a useful shape.',
  lockedFieldIds = [],
  undeletableFieldIds = [],
  builtInFieldIds = [],
  labelLockedFieldIds = [],
  missingOptionalBuiltInIds,
  deleteValueWarning,
}: FieldSchemaComposerProps): ReactElement {
  const confirmDelete = useConfirmDelete()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingField, setEditingField] = useState<DataField | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  async function persist(nextFields: DataField[], showToast = true) {
    try {
      await onChange(nextFields)
    } catch (caught) {
      if (isStepUpCancelled(caught)) throw caught
      console.error('[FieldSchemaComposer] Schema update failed:', caught)
      if (showToast) {
        pushToast({
          kind: 'error',
          title: 'Schema update failed',
          body: getErrorMessage(caught, 'Could not update fields'),
          location: 'data-workspace',
        })
      }
      throw caught
    }
  }

  async function persistInBackground(nextFields: DataField[]) {
    try {
      await persist(nextFields)
    } catch (_caught) {
      // persist already surfaced operation errors; cancellation needs no UI.
    }
  }

  function openNewField() {
    setEditingField(null)
    setDialogOpen(true)
  }

  function openField(field: DataField) {
    setEditingField(field)
    setDialogOpen(true)
  }

  function requestDelete(field: DataField) {
    confirmDelete({
      title: `Delete field "${field.label}"?`,
      description: deleteValueWarning,
      commit: () => {
        void persistInBackground(fields.filter((item) => item.id !== field.id))
      },
    })
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, fieldId: string) {
    event.dataTransfer.setData('text/plain', fieldId)
    event.dataTransfer.effectAllowed = 'move'
    setDraggingId(fieldId)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, fieldId: string) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverId(fieldId)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetId: string) {
    event.preventDefault()
    const sourceId = draggingId ?? event.dataTransfer.getData('text/plain')
    setDraggingId(null)
    setDragOverId(null)
    if (!sourceId || sourceId === targetId) return

    const fromIndex = fields.findIndex((field) => field.id === sourceId)
    const toIndex = fields.findIndex((field) => field.id === targetId)
    if (fromIndex < 0 || toIndex < 0) return

    const nextFields = [...fields]
    const [moved] = nextFields.splice(fromIndex, 1)
    if (!moved) return
    nextFields.splice(toIndex, 0, moved)
    void persistInBackground(nextFields)
  }

  function moveField(index: number, offset: -1 | 1) {
    const target = index + offset
    if (target < 0 || target >= fields.length) return
    if (lockedFieldIds.includes(fields[target]!.id)) return
    const nextFields = [...fields]
    const [moved] = nextFields.splice(index, 1)
    if (!moved) return
    nextFields.splice(target, 0, moved)
    void persistInBackground(nextFields)
  }

  const addAction = canEdit ? (
    <Button variant="primary" size="sm" type="button" onClick={openNewField}>
      <PlusIcon size={12} aria-hidden="true" />
      {addLabel}
    </Button>
  ) : null

  const composer = (
    <section className={styles.composer} aria-label={sectionTitle ?? title}>
      {!sectionTitle && <div className={styles.heading}>
        <div className={styles.headingText}>
          <div className={styles.titleRow}>
            <h3>{title}</h3>
            <span className={styles.count}>{fields.length}</span>
          </div>
          {description && <p>{description}</p>}
        </div>
        {addAction}
      </div>}

      {fields.length > 0 ? (
        <div className={styles.list}>
          {fields.map((field, index) => {
            const locked = lockedFieldIds.includes(field.id)
            const deletable = !locked && !undeletableFieldIds.includes(field.id)
            const canSetPrimary = primaryFieldId !== undefined
              && onPrimaryFieldChange !== undefined
              && isPrimaryFieldCandidate(field)
            const canMoveUp = canEdit
              && !locked
              && index > 0
              && !lockedFieldIds.includes(fields[index - 1]!.id)
            const canMoveDown = canEdit
              && !locked
              && index < fields.length - 1
              && !lockedFieldIds.includes(fields[index + 1]!.id)
            return (
              <FieldRow
                key={field.id}
                field={field}
                canDrag={canEdit && !locked}
                canMoveUp={canMoveUp}
                canMoveDown={canMoveDown}
                canEdit={canEdit}
                primary={field.id === primaryFieldId}
                canSetPrimary={canSetPrimary}
                deletable={deletable}
                deleteTooltip={deletable ? undefined : 'This field is required by the collection'}
                mandatory={locked}
                optionalBuiltIn={builtInFieldIds.includes(field.id) && !locked}
                isEditing={editingField?.id === field.id}
                isDragOver={dragOverId === field.id}
                isDragging={draggingId === field.id}
                onEditToggle={() => openField(field)}
                onDelete={() => requestDelete(field)}
                onMoveUp={() => moveField(index, -1)}
                onMoveDown={() => moveField(index, 1)}
                onSetPrimary={() => {
                  void onPrimaryFieldChange?.(field.id)
                }}
                onDragStart={(event) => handleDragStart(event, field.id)}
                onDragOver={(event) => handleDragOver(event, field.id)}
                onDragLeave={() => setDragOverId(null)}
                onDrop={(event) => handleDrop(event, field.id)}
                onDragEnd={() => {
                  setDraggingId(null)
                  setDragOverId(null)
                }}
              />
            )
          })}
        </div>
      ) : (
        <div className={styles.empty}>
          <span className={styles.emptyTitle}>Start with the record structure</span>
          <span>{emptyMessage}</span>
          {canEdit && (
            <Button variant="secondary" size="sm" type="button" onClick={openNewField}>
              <PlusIcon size={12} aria-hidden="true" />
              {addLabel}
            </Button>
          )}
        </div>
      )}

      {dialogOpen && (
        <NewFieldDialog
          open
          onClose={() => {
            setDialogOpen(false)
            setEditingField(null)
          }}
          existingFieldIds={fields
            .filter((field) => field.id !== editingField?.id)
            .map((field) => field.id)}
          tables={tables}
          initialField={editingField ?? undefined}
          lockLabel={Boolean(editingField && labelLockedFieldIds.includes(editingField.id))}
          missingOptionalBuiltInIds={editingField ? undefined : missingOptionalBuiltInIds}
          onCreate={async (field) => {
            const nextFields = editingField
              ? fields.map((item) => item.id === editingField.id ? field : item)
              : [...fields, field]
            await persist(nextFields, false)
            setDialogOpen(false)
            setEditingField(null)
          }}
        />
      )}
    </section>
  )

  if (sectionTitle) {
    return (
      <Section
        title={sectionTitle}
        icon={sectionIcon}
        headerAction={addAction}
        defaultOpen
        flush
      >
        {composer}
      </Section>
    )
  }

  return composer
}
