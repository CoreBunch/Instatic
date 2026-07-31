/**
 * FieldRow — a single field row in the FieldsSection list. Presentational:
 * drag-and-drop, edit, and delete are surfaced as handler props; all state and
 * persistence live in FieldsSection.
 */
import type { DragEvent, ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { TagPill } from '@ui/components/TagPill'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { LockSolidIcon } from 'pixel-art-icons/icons/lock-solid'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { StarSolidIcon } from 'pixel-art-icons/icons/star-solid'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import type { DataField } from '@core/data/schemas'
import { FIELD_TYPE_LABELS } from './fieldGuards'
import styles from './DataInspector.module.css'

interface FieldRowProps {
  field: DataField
  canDrag: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  canEdit: boolean
  primary: boolean
  canSetPrimary: boolean
  deletable: boolean
  /** Tooltip for a disabled delete button (undefined when deletable). */
  deleteTooltip?: string
  /** Mandatory postType built-in — rendered as a locked row with no actions. */
  mandatory: boolean
  /** Optional postType built-in — shows the "built-in" badge. */
  optionalBuiltIn: boolean
  isEditing: boolean
  isDragOver: boolean
  isDragging: boolean
  onEditToggle: () => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onSetPrimary: () => void
  onDragStart: (e: DragEvent<HTMLDivElement>) => void
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}

export function FieldRow({
  field,
  canDrag,
  canMoveUp,
  canMoveDown,
  canEdit,
  primary,
  canSetPrimary,
  deletable,
  deleteTooltip,
  mandatory,
  optionalBuiltIn,
  isEditing,
  isDragOver,
  isDragging,
  onEditToggle,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSetPrimary,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: FieldRowProps): ReactElement {
  return (
    <div
      className={[
        styles.fieldRow,
        isDragOver ? styles.fieldRowDragOver : '',
        isDragging ? styles.fieldRowDragging : '',
      ]
        .filter(Boolean)
        .join(' ')}
      draggable={canDrag}
      onDragStart={canDrag ? onDragStart : undefined}
      onDragOver={canDrag ? onDragOver : undefined}
      onDragLeave={canDrag ? onDragLeave : undefined}
      onDrop={canDrag ? onDrop : undefined}
      onDragEnd={canDrag ? onDragEnd : undefined}
    >
      {/* Field type icon — called directly (not as <FieldIcon/>) to avoid the
          react-hooks/static-components rule, matching DataGridHeaderCell. */}
      <span className={styles.fieldIcon} aria-hidden="true">
        {getFieldIcon(field.type)({ size: 13 })}
      </span>

      {/* Name */}
      <span className={styles.fieldName}>{field.label}</span>

      {/* Mandatory built-in lock badge */}
      {mandatory && (
        <span className={styles.lockedBadge} aria-label="Required field — locked">
          <LockSolidIcon size={10} aria-hidden="true" />
        </span>
      )}

      {/* Optional built-in badge */}
      {!mandatory && optionalBuiltIn && (
        <span className={styles.builtInBadge}>built-in</span>
      )}

      {/* Type badge */}
      {!mandatory && (
        <TagPill
          label={FIELD_TYPE_LABELS[field.type]}
          size="xs"
        />
      )}

      {canSetPrimary && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          type="button"
          className={styles.primaryFieldButton}
          pressed={primary}
          aria-label={primary
            ? `${field.label} is the primary field`
            : `Set ${field.label} as primary field`}
          tooltip={primary ? 'Primary field' : 'Set as primary field'}
          onClick={primary ? undefined : onSetPrimary}
        >
          <StarSolidIcon size={11} aria-hidden="true" />
        </Button>
      )}

      {/* Actions — not shown for mandatory built-ins */}
      {!mandatory && canEdit && (
        <div className={styles.fieldActions}>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            type="button"
            aria-label={`Move ${field.label} up`}
            tooltip={`Move ${field.label} up`}
            disabled={!canMoveUp}
            onClick={onMoveUp}
          >
            <ArrowUpIcon size={11} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            type="button"
            aria-label={`Move ${field.label} down`}
            tooltip={`Move ${field.label} down`}
            disabled={!canMoveDown}
            onClick={onMoveDown}
          >
            <ArrowDownIcon size={11} aria-hidden="true" />
          </Button>
          {/* Edit — always shown (lock only for label/type in the form) */}
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            type="button"
            aria-label={`Edit ${field.label}`}
            tooltip={`Edit ${field.label}`}
            pressed={isEditing}
            onClick={onEditToggle}
          >
            <EditSolidIcon size={12} aria-hidden="true" />
          </Button>
          {/* Delete */}
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            tone="danger"
            type="button"
            aria-label={`Delete ${field.label}`}
            tooltip={deleteTooltip ?? `Delete ${field.label}`}
            disabled={!deletable}
            onClick={deletable ? onDelete : undefined}
          >
            <TrashSolidIcon size={12} aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )
}
