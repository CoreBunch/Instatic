/**
 * FieldsSection adapts a persisted DataTable to the shared schema composer.
 * Creation, table settings, and repeater setup therefore use one field model
 * and one interaction language.
 */
import type { ReactElement } from 'react'
import { ListBoxSolidIcon } from 'pixel-art-icons/icons/list-box-solid'
import { FieldSchemaComposer } from '@admin/pages/data/components/FieldSchemaComposer'
import {
  POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS,
  type DataTable,
  type UpdateDataTableInput,
} from '@core/data/schemas'
import {
  isFieldDeletable,
  isFieldFullyLocked,
  isLabelLocked,
} from './fieldGuards'

interface FieldsSectionProps {
  table: DataTable
  tables: DataTable[]
  rowCount: number
  onUpdateTable: (input: UpdateDataTableInput) => Promise<DataTable>
  canEdit: boolean
  primaryFieldId: string
  onPrimaryFieldChange: (fieldId: string) => Promise<void> | void
}

export function FieldsSection({
  table,
  tables,
  rowCount,
  onUpdateTable,
  canEdit,
  primaryFieldId,
  onPrimaryFieldChange,
}: FieldsSectionProps): ReactElement {
  const lockedFieldIds = table.fields
    .filter((field) => isFieldFullyLocked(field, table))
    .map((field) => field.id)
  const undeletableFieldIds = table.fields
    .filter((field) => !isFieldDeletable(field, table))
    .map((field) => field.id)
  const builtInFieldIds = table.fields
    .filter((field) => field.builtIn)
    .map((field) => field.id)
  const labelLockedFieldIds = table.fields
    .filter((field) => isLabelLocked(field, table))
    .map((field) => field.id)
  const missingOptionalBuiltInIds = table.kind === 'postType'
    ? (POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS as readonly string[]).filter(
        (id) => !table.fields.some((field) => field.id === id),
      )
    : []

  return (
    <FieldSchemaComposer
      fields={table.fields}
      tables={tables}
      onChange={async (fields) => {
        await onUpdateTable({ fields })
      }}
      canEdit={canEdit}
      sectionTitle={`Schema · ${table.fields.length} fields`}
      sectionIcon={ListBoxSolidIcon}
      primaryFieldId={primaryFieldId}
      onPrimaryFieldChange={onPrimaryFieldChange}
      lockedFieldIds={lockedFieldIds}
      undeletableFieldIds={undeletableFieldIds}
      builtInFieldIds={builtInFieldIds}
      labelLockedFieldIds={labelLockedFieldIds}
      missingOptionalBuiltInIds={missingOptionalBuiltInIds}
      deleteValueWarning={rowCount > 0
        ? `This removes the field and its values across ${rowCount} ${rowCount === 1 ? 'record' : 'records'}.`
        : undefined}
    />
  )
}
