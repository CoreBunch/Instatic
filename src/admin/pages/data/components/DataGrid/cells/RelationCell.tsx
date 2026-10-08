import type { ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { useLocalizedData } from '@admin/pages/data/localizedData'
import { readDisplayTitle, readStringArrayCell } from '@core/data/cells'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { DataField, DataTable } from '@core/data/schemas'
import styles from './cells.module.css'

type RelationField = Extract<DataField, { type: 'relation' }>

export interface RelationCellProps extends CellEditorProps<RelationField> {
  /** Called when the user wants to open the relation picker. */
  onOpenPicker?: () => void
  tables?: DataTable[]
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
  tables = [],
}: RelationCellProps): ReactElement {
  const localization = useLocalizedData()
  const isMulti = field.allowMultiple === true

  const currentIds: string[] = isMulti
    ? readStringArrayCell({ [field.id]: value }, field.id)
    : typeof value === 'string'
      ? [value]
      : []

  const hasValue = currentIds.length > 0
  const targetTable = tables.find(table => table.id === field.targetTableId)
  const targetRow = currentIds[0] ? resolveRelationTarget?.(currentIds[0]) : null
  const displayName = isMulti ? `${currentIds.length} related` : !targetTable || !targetRow ? 'Related row unavailable' :
    targetTable.fields.some(item => item.type === 'localizedText') && !localization?.context ? 'Choose a content language' :
    readDisplayTitle(targetRow.cells, targetTable, localization?.context)

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
          <span>{displayName}</span>
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
