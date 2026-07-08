import { useState } from 'react'
import { CellEditorRenderer } from '@admin/pages/data/components/DataGrid/cells/CellEditorRenderer'
import { RelationPickerDialog } from '@admin/pages/data/components/RelationPickerDialog/RelationPickerDialog'
import { emptyCellValue } from '@admin/pages/data/utils/fieldDefaults'
import type { DataField, DataRowCells, DataTable } from '@core/data/schemas'
import { useRelationTargetRows } from '../../hooks/useRelationTargetRows'
import styles from '../../ContentPage.module.css'

interface ContentCustomFieldsProps {
  /** The collection's custom (non-built-in) fields, pre-filtered by the panel. */
  fields: DataField[]
  entryId: string
  /** Every data table (all kinds) — relation custom fields can target any of them. */
  tables: DataTable[]
  /** Draft values of the custom fields, keyed by field id. */
  customCells: DataRowCells
  readOnly: boolean
  onCustomCellChange: (fieldId: string, value: unknown) => void
}

/**
 * Generic editors for a post-type collection's custom fields, rendered at the
 * bottom of the Content settings panel. Reuses the Data workspace's per-type
 * cell editors (`CellEditorRenderer`, `context="detail"`) so every field type
 * behaves identically in both workspaces.
 *
 * Lazy-loaded by `ContentSettingsPanel` — the cell-editor graph (media picker
 * workspace, relation picker) is too heavy for the Content page's initial
 * chunk budget.
 */
export function ContentCustomFields({
  fields,
  entryId,
  tables,
  customCells,
  readOnly,
  onCustomCellChange,
}: ContentCustomFieldsProps) {
  const [relationPickerFieldId, setRelationPickerFieldId] = useState<string | null>(null)
  const resolveRelationRow = useRelationTargetRows(fields)

  // Derive relation-picker props from the open field id (same pattern as the
  // Data workspace's RowDetail form).
  const openRelationField = fields.find((field) => field.id === relationPickerFieldId)
  const relationPickerField = openRelationField?.type === 'relation' ? openRelationField : null
  const relationPickerTargetTable = relationPickerField
    ? tables.find((table) => table.id === relationPickerField.targetTableId) ?? null
    : null
  const relationPickerCurrentValue = relationPickerField
    ? ((customCells[relationPickerField.id] ?? null) as string | string[] | null)
    : null

  return (
    <>
      {fields.map((field) => (
        <div key={field.id} className={styles.customField} data-testid={`content-custom-field-${field.id}`}>
          <span>{field.label}</span>
          {field.description && <small>{field.description}</small>}
          <CellEditorRenderer
            field={field}
            value={customCells[field.id] ?? emptyCellValue(field)}
            onChange={(next) => onCustomCellChange(field.id, next)}
            context="detail"
            readOnly={readOnly}
            rowId={entryId}
            resolveRelationTarget={resolveRelationRow}
            onOpenPicker={
              field.type === 'relation'
                ? () => setRelationPickerFieldId(field.id)
                : undefined
            }
          />
        </div>
      ))}

      <RelationPickerDialog
        open={relationPickerField !== null}
        onClose={() => setRelationPickerFieldId(null)}
        targetTable={relationPickerTargetTable}
        currentValue={relationPickerCurrentValue}
        allowMultiple={relationPickerField?.allowMultiple ?? false}
        onPick={(next) => {
          if (relationPickerField) onCustomCellChange(relationPickerField.id, next)
          setRelationPickerFieldId(null)
        }}
      />
    </>
  )
}
