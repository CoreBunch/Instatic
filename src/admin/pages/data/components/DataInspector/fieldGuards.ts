/**
 * fieldGuards — PostType field classification + the human-readable field-type
 * label map. Pure logic shared by FieldsSection, FieldRow, and FieldEditForm.
 *
 * PostType field guards:
 *   - Mandatory built-ins (title, slug): locked — no edit/delete.
 *   - Optional built-ins (body, featuredMedia, seo):
 *     deletable; editable for description/required only.
 *   - Custom non-built-in fields: fully editable and deletable.
 */
import {
  POST_TYPE_MANDATORY_FIELD_IDS,
  type DataField,
  type DataFieldType,
  type DataTable,
} from '@core/data/schemas'
import { isPostTypeBuiltInFieldId } from '@core/data/fields'

export const FIELD_TYPE_LABELS: Record<DataFieldType, string> = {
  text: 'Text',
  longText: 'Long text',
  richText: 'Rich text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  dateTime: 'Date & time',
  select: 'Select',
  multiSelect: 'Multi-select',
  url: 'URL',
  email: 'Email',
  media: 'Media',
  relation: 'Relation',
  pageTree: 'Page tree',
  fieldSchema: 'Field schema',
  seoMetadata: 'SEO metadata',
}

export function isMandatoryField(fieldId: string): boolean {
  return (POST_TYPE_MANDATORY_FIELD_IDS as readonly string[]).includes(fieldId)
}

export function isOptionalBuiltIn(field: DataField): boolean {
  return field.builtIn === true && !isMandatoryField(field.id)
}

/**
 * A built-in field on a SYSTEM table — frozen for everyone (the server rejects
 * edits/removals via `assertSystemTableUpdateAllowed`). Unlike a post type's
 * optional built-ins, these are not editable at all.
 */
export function isSystemBuiltInField(field: DataField, table: Pick<DataTable, 'system'>): boolean {
  return table.system === true && field.builtIn === true
}

/**
 * Whether a field's DEFINITION is fully frozen — no edit, no delete, no
 * reorder. Covers post-type mandatory fields and every built-in on a system
 * table.
 */
export function isFieldFullyLocked(field: DataField, table: DataTable): boolean {
  if (table.kind === 'postType' && isMandatoryField(field.id)) return true
  if (isSystemBuiltInField(field, table)) return true
  return false
}

/** Whether a field can be deleted from its table. */
export function isFieldDeletable(field: DataField, table: DataTable): boolean {
  if (field.id === table.primaryFieldId) return false
  if (isFieldFullyLocked(field, table)) return false
  return true
}

/** Tooltip text for a disabled delete button, if applicable. */
export function deleteTooltip(field: DataField, table: DataTable): string | undefined {
  if (field.id === table.primaryFieldId) return 'Cannot delete the primary field'
  if (table.kind === 'postType' && isMandatoryField(field.id)) {
    return 'Required by all post types — cannot be deleted'
  }
  if (isSystemBuiltInField(field, table)) {
    return 'Built-in field on a system table — cannot be deleted'
  }
  return undefined
}

/** Whether the label input should be locked for this field. */
export function isLabelLocked(field: DataField, table: DataTable): boolean {
  if (table.kind === 'postType' && isPostTypeBuiltInFieldId(field.id)) return true
  if (isSystemBuiltInField(field, table)) return true
  return false
}
