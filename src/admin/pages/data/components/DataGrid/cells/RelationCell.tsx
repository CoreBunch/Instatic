import type { ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { readStringArrayCell, readDisplayTitle } from '@core/data/cells'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import styles from './cells.module.css'

type RelationField = Extract<DataField, { type: 'relation' }>

/**
 * RelationCell — renders a button that shows the current relation display
 * name and accepts an `onOpenPicker` prop for the parent to wire up a
 * RelationPickerDialog.
 *
 */
export interface RelationCellProps extends CellEditorProps<RelationField> {
  /** Called when the user wants to open the relation picker. */
  onOpenPicker?: () => void
  targetTable?: DataTable
}

function resolveDisplayName(
  ids: string[],
  resolveRelationTarget: ((id: string) => DataRow | null) | undefined,
  targetTable: DataTable | undefined,
): string {
  if (ids.length === 0) return ''

  return ids.map((id) => {
    const target = resolveRelationTarget?.(id)
    return target ? readDisplayTitle(target.cells, targetTable) : id
  }).join(', ')
}

export function RelationCell({
  field,
  value,
  onChange,
  onCommit,
  readOnly,
  ariaLabel,
  resolveRelationTarget,
  onOpenPicker,
  targetTable,
}: RelationCellProps): ReactElement {
  const isMulti = field.allowMultiple === true

  const currentIds: string[] = isMulti
    ? readStringArrayCell({ [field.id]: value }, field.id)
    : typeof value === 'string'
      ? [value]
      : []

  const hasValue = currentIds.length > 0
  const displayName = resolveDisplayName(currentIds, resolveRelationTarget, targetTable)

  function handleClear() {
    onChange(isMulti ? [] : null)
    onCommit?.()
  }

  return (
    <div className={styles.relationButton}>
      <Button
        variant="secondary"
        size="sm"
        disabled={readOnly}
        aria-label={ariaLabel ?? `${field.label}: ${hasValue ? displayName : 'No relation'}`}
        onClick={() => onOpenPicker?.()}
        align="start"
        fullWidth
      >
        <LinkIcon size={14} />
        {hasValue ? (
          <span className={styles.relationNames} title={displayName}>{displayName}</span>
        ) : (
          <span className={styles.relationEmpty}>Choose…</span>
        )}
      </Button>

      {hasValue && !readOnly && (
        <Button
          variant="ghost"
          size="xs"
          tooltip="Clear relation"
          aria-label="Clear relation"
          onClick={handleClear}
        >
          Clear
        </Button>
      )}
    </div>
  )
}
